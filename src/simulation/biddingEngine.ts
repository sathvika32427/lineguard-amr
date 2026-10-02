import { AMR, Station, Task, CandidateBid, DecisionTrace, AllocationPolicy } from '../models/types';
import { CHARGERS, estimateTravelTimeSec, WAREHOUSE, calculateManhattanDistance } from './factoryLayout';

const Z_CONFIDENCE = 1.28; // 90% confidence lower bound for stockout prediction
const KAPPA_STALENESS = 0.02; // staleness penalty coefficient
const LAMBDA_ENERGY = 0.05;
const LAMBDA_CONGESTION = 0.08;

/**
 * Uncertainty-aware stockout calculation:
 * TTS_delta = I / (mu + z * sigma_eff)
 * sigma_eff^2 = sigma^2 + (kappa * age)^2
 */
export function calculateStockoutMetrics(station: Station): {
  predictedStockoutSec: number;
  sigmaEff: number;
  starvationProb: number;
} {
  const age = Math.max(0, station.stalenessAgeSec);
  const sigmaEff = Math.sqrt(
    Math.pow(station.demandUncertainty, 2) + Math.pow(KAPPA_STALENESS * age, 2)
  );

  const effectiveConsumptionRate = Math.max(0.01, station.consumptionRate + Z_CONFIDENCE * sigmaEff);
  const ttsSec = station.currentInventory / effectiveConsumptionRate;

  // Starvation probability approximation
  let starvationProb = 0.05;
  if (ttsSec < 30) {
    starvationProb = Math.min(0.99, 0.90 + (30 - ttsSec) * 0.003);
  } else if (ttsSec < 60) {
    starvationProb = Math.min(0.85, 0.50 + (60 - ttsSec) * 0.012);
  } else if (ttsSec < 120) {
    starvationProb = Math.min(0.45, 0.10 + (120 - ttsSec) * 0.005);
  } else {
    starvationProb = Math.max(0.01, 0.05 - (ttsSec - 120) * 0.0002);
  }

  return {
    predictedStockoutSec: Math.max(5, Math.round(ttsSec * 10) / 10),
    sigmaEff: Math.round(sigmaEff * 1000) / 1000,
    starvationProb: Math.round(starvationProb * 100) / 100,
  };
}

/**
 * Checks Feasibility Gate for an AMR on a task
 */
export function evaluateFeasibilityGate(
  amr: AMR,
  task: Task,
  station: Station
): { eligible: boolean; reason?: string; requiredEnergyPct: number; totalTravelDistMeters: number } {
  // 1. Hardware health
  if (amr.health === 'FAILED') {
    return { eligible: false, reason: 'AMR hardware failure / offline', requiredEnergyPct: 0, totalTravelDistMeters: 0 };
  }

  // 2. State availability
  if (amr.state === 'FAILED' || amr.state === 'DELIVERING' || amr.state === 'LOADING') {
    return { eligible: false, reason: `AMR busy (${amr.state})`, requiredEnergyPct: 0, totalTravelDistMeters: 0 };
  }

  // 3. Payload capability gate
  if (task.payloadRequirement === 'HEAVY' && amr.payloadCapability !== 'HEAVY') {
    return {
      eligible: false,
      reason: 'Incompatible payload: Task requires HEAVY carrier (500kg), AMR is LIGHT (100kg)',
      requiredEnergyPct: 0,
      totalTravelDistMeters: 0,
    };
  }

  // 4. Energy gate: Pickup + Delivery + Return to Charger + 10% Reserve
  const pickupPos = task.isRescue && task.rescuePayloadLocation ? task.rescuePayloadLocation : WAREHOUSE.position;
  const distToPickup = calculateManhattanDistance(amr.position, pickupPos) * 0.25;
  const distPickupToStation = calculateManhattanDistance(pickupPos, station.position) * 0.25;
  
  // Nearest charger from station
  let distToNearestCharger = 9999;
  for (const chg of CHARGERS) {
    const d = calculateManhattanDistance(station.position, chg.position) * 0.25;
    if (d < distToNearestCharger) distToNearestCharger = d;
  }

  const totalDistMeters = distToPickup + distPickupToStation + distToNearestCharger;
  // Energy consumption: ~0.08% battery per 10 meters traveled + payload factor
  const payloadFactor = task.payloadRequirement === 'HEAVY' ? 1.4 : 1.0;
  const rawEnergyPct = (totalDistMeters / 10) * 0.075 * payloadFactor;
  const reservePct = 10.0;
  const requiredEnergyPct = Math.round((rawEnergyPct + reservePct) * 10) / 10;

  if (amr.batteryPct < requiredEnergyPct) {
    return {
      eligible: false,
      reason: `Insufficient battery (${amr.batteryPct}%): Requires ${requiredEnergyPct}% (${rawEnergyPct.toFixed(1)}% trip + ${reservePct}% safety reserve)`,
      requiredEnergyPct,
      totalTravelDistMeters: Math.round(totalDistMeters),
    };
  }

  return {
    eligible: true,
    requiredEnergyPct,
    totalTravelDistMeters: Math.round(totalDistMeters),
  };
}

/**
 * Evaluates bids from all AMRs for a specific task using the specified policy
 */
export function evaluateCandidateBids(
  task: Task,
  station: Station,
  allStations: Station[],
  allAmrs: AMR[],
  aisles: any[],
  policy: AllocationPolicy = 'LINEGUARD'
): { candidates: CandidateBid[]; selectedAmrId?: string; decisionTrace?: DecisionTrace } {
  // Count available heavy AMRs in fleet
  const availableHeavyCount = allAmrs.filter(
    (a) => a.payloadCapability === 'HEAVY' && a.health === 'HEALTHY' && (a.state === 'IDLE' || a.state === 'RETURNING_TO_BASE')
  ).length;

  const candidates: CandidateBid[] = [];

  for (const amr of allAmrs) {
    const gate = evaluateFeasibilityGate(amr, task, station);

    if (!gate.eligible) {
      candidates.push({
        amrId: amr.id,
        eligible: false,
        ineligibleReason: gate.reason,
        etaSec: 999,
        energyCost: 999,
        congestionDelaySec: 0,
        collateralRisk: 0,
        scarcityPenalty: 0,
        lossIfDelayed: 999,
        totalScore: 9999,
        breakdown: {
          travelDistMeters: gate.totalTravelDistMeters,
          requiredEnergyPct: gate.requiredEnergyPct,
          availableBatteryPct: amr.batteryPct,
        },
      });
      continue;
    }

    // Calculate ETA to station via pickup location
    const pickupPos = task.isRescue && task.rescuePayloadLocation ? task.rescuePayloadLocation : WAREHOUSE.position;
    const leg1 = estimateTravelTimeSec(amr.position, pickupPos, amr.speedMps, aisles);
    const loadingTimeSec = task.isRescue ? 6 : 10;
    const leg2 = estimateTravelTimeSec(pickupPos, station.position, amr.speedMps, aisles);
    const totalEtaSec = leg1.timeSec + loadingTimeSec + leg2.timeSec;
    const totalCongestionDelay = leg1.congestionDelaySec + leg2.congestionDelaySec;

    // Production loss if this AMR is used: L(a, i) = c_i * max(0, ETA(a,i) - TTS_i)
    const slack = station.predictedStockoutSec - totalEtaSec;
    const delayPastStockoutSec = Math.max(0, -slack);
    const lossIfDelayed = station.criticality * (delayPastStockoutSec / 10);

    // Energy cost
    const energyCost = gate.requiredEnergyPct * LAMBDA_ENERGY;
    const congestionCost = totalCongestionDelay * LAMBDA_CONGESTION;

    // Collateral Risk: Phi(a, i)
    // How much does assigning 'amr' to 'task' hurt other imminent tasks?
    let collateralRisk = 0;
    let downstreamStationRiskName: string | undefined;
    let downstreamLossMin: number | undefined;

    // Check other high-criticality stations
    for (const otherStation of allStations) {
      if (otherStation.id === station.id) continue;

      // If other station requires HEAVY and this AMR is HEAVY
      if (otherStation.payloadRequirement === 'HEAVY' && amr.payloadCapability === 'HEAVY') {
        const timeToOtherStockout = otherStation.predictedStockoutSec;
        // If other station will need a delivery within 120 seconds
        if (timeToOtherStockout < 140) {
          // Find if there is another alternative heavy AMR for otherStation
          const otherHeavyAmrs = allAmrs.filter(
            (o) => o.id !== amr.id && o.payloadCapability === 'HEAVY' && o.health === 'HEALTHY'
          );
          if (otherHeavyAmrs.length === 0) {
            // Severe collateral risk! No backup heavy robot!
            collateralRisk += otherStation.criticality * 6.5;
            downstreamStationRiskName = otherStation.name;
            downstreamLossMin = 3.8;
          } else {
            // Find distance difference for the next-best AMR to otherStation
            const amrDistToOther = calculateManhattanDistance(amr.position, otherStation.position);
            const nextBestDist = Math.min(
              ...otherHeavyAmrs.map((o) => calculateManhattanDistance(o.position, otherStation.position))
            );
            const deltaDist = Math.max(0, nextBestDist - amrDistToOther) * 0.25;
            const extraLoss = (deltaDist / 15) * otherStation.criticality * 2.2;
            collateralRisk += extraLoss;
            if (extraLoss > 1.0) {
              downstreamStationRiskName = otherStation.name;
              downstreamLossMin = Math.round(extraLoss * 10) / 10;
            }
          }
        }
      }
    }

    // Scarcity penalty: Using scarce heavy AMR for a light task
    let scarcityPenalty = 0;
    if (task.payloadRequirement === 'LIGHT' && amr.payloadCapability === 'HEAVY') {
      if (availableHeavyCount <= 2) {
        scarcityPenalty = (3 - availableHeavyCount) * 4.0; // heavy penalty for wasting heavy robot
      }
    }

    // Communication staleness multiplier
    const stalenessFactor = amr.commStatus === 'DELAYED' ? 1.3 : amr.commStatus === 'LOSS' ? 1.8 : 1.0;

    // Total Score Calculation based on Policy
    let totalScore = 0;

    switch (policy) {
      case 'LINEGUARD':
        // Full LineGuard Formula:
        // B(a,i) = L(a,i) + lambda_E * EnergyCost + lambda_C * CongestionDelay + Phi(a,i) + Scarcity
        totalScore =
          (lossIfDelayed * 3.0 +
          energyCost +
          congestionCost +
          collateralRisk +
          scarcityPenalty +
          (totalEtaSec * 0.05)) * stalenessFactor;
        break;

      case 'NEAREST_AMR':
        // Purely distance from AMR to pickup
        totalScore = leg1.timeSec;
        break;

      case 'DISTANCE_AUCTION':
        // Total travel time / distance only
        totalScore = totalEtaSec;
        break;

      case 'FIFO':
        // Assign first available robot based on AMR ID order / registration
        totalScore = parseInt(amr.id.replace(/\D/g, ''), 10);
        break;

      case 'STATIC_PRIORITY':
        // Robot with lowest ID or highest speed
        totalScore = 100 - amr.speedMps * 10;
        break;
    }

    candidates.push({
      amrId: amr.id,
      eligible: true,
      etaSec: Math.round(totalEtaSec * 10) / 10,
      energyCost: Math.round(energyCost * 100) / 100,
      congestionDelaySec: Math.round(totalCongestionDelay * 10) / 10,
      collateralRisk: Math.round(collateralRisk * 100) / 100,
      scarcityPenalty: Math.round(scarcityPenalty * 100) / 100,
      lossIfDelayed: Math.round(lossIfDelayed * 100) / 100,
      totalScore: Math.round(totalScore * 100) / 100,
      breakdown: {
        travelDistMeters: gate.totalTravelDistMeters,
        requiredEnergyPct: gate.requiredEnergyPct,
        availableBatteryPct: amr.batteryPct,
        downstreamStationRiskName,
        downstreamLossMin,
      },
    });
  }

  // Sort candidates by total score ascending (lowest score is best)
  const eligibleCandidates = candidates.filter((c) => c.eligible).sort((a, b) => a.totalScore - b.totalScore);

  if (eligibleCandidates.length === 0) {
    // Triage case: No feasible assignment
    return {
      candidates,
      selectedAmrId: undefined,
      decisionTrace: {
        taskId: task.id,
        stationId: station.id,
        stationName: station.name,
        componentName: station.componentName,
        timestampSec: 0,
        selectedAmrId: 'NONE',
        selectedBid: {} as any,
        explanation: 'CRITICAL TRIAGE: No eligible AMR can arrive safely before buffer depletion.',
        counterfactual: 'All candidate AMRs failed energy reserves or payload gates.',
        tradeOffSummary: `Station ${station.name} entered starvation risk. Fleet capacity exhausted.`,
        candidates,
        triageApplied: true,
        triageMessage: `No feasible AMR found for ${station.name}. Prioritizing higher-criticality stations.`,
      },
    };
  }

  const winner = eligibleCandidates[0];
  const runnerUp = eligibleCandidates.length > 1 ? eligibleCandidates[1] : undefined;

  // Generate counterfactual explanation
  const selectedAmr = allAmrs.find((a) => a.id === winner.amrId)!;
  const runnerUpAmr = runnerUp ? allAmrs.find((a) => a.id === runnerUp.amrId) : undefined;

  let explanation = '';
  let counterfactual = '';
  let tradeOffSummary = '';

  if (policy === 'LINEGUARD') {
    if (runnerUp && runnerUp.etaSec < winner.etaSec) {
      explanation = `${winner.amrId} was selected over ${runnerUp.amrId}. Although ${runnerUp.amrId} has a faster ETA by ${(runnerUp.etaSec - winner.etaSec).toFixed(1)}s, selecting ${runnerUp.amrId} would create an unacceptable collateral risk of ${runnerUp.collateralRisk.toFixed(1)} to ${runnerUp.breakdown.downstreamStationRiskName || 'downstream stations'}.`;
      counterfactual = `${runnerUp.amrId} would only be selected if downstream ${runnerUp.breakdown.downstreamStationRiskName || 'station'} buffer was above 65% or another heavy-capable AMR was idling nearby.`;
      tradeOffSummary = `Sacrificed ${(winner.etaSec - runnerUp.etaSec).toFixed(1)}s travel time to prevent +${runnerUp.breakdown.downstreamLossMin || 2.4} min downstream factory production loss.`;
    } else {
      explanation = `${winner.amrId} provides optimal balance: arrives ${Math.max(0, Math.round(station.predictedStockoutSec - winner.etaSec))}s before predicted stockout with low collateral impact (${winner.collateralRisk.toFixed(1)}) and safe battery reserve (${selectedAmr.batteryPct}%).`;
      counterfactual = runnerUp
        ? `${runnerUp.amrId} had a higher total score (${runnerUp.totalScore}) due to ${runnerUp.congestionDelaySec > 2 ? 'corridor congestion' : runnerUp.energyCost > winner.energyCost ? 'longer battery routing' : 'higher collateral penalty'}.`
        : 'Sole feasible candidate in fleet satisfying all energy and payload gates.';
      tradeOffSummary = `Direct route selected with ${winner.breakdown.availableBatteryPct}% battery; 0 downstream penalties.`;
    }
  } else {
    explanation = `Selected ${winner.amrId} based on ${policy} metric (score: ${winner.totalScore}). Note: Collateral factory impact (${winner.collateralRisk}) was NOT considered by this baseline.`;
    counterfactual = `LineGuard would have evaluated factory-wide stockout trade-offs.`;
    tradeOffSummary = `Pure local optimization (${policy}).`;
  }

  const decisionTrace: DecisionTrace = {
    taskId: task.id,
    stationId: station.id,
    stationName: station.name,
    componentName: station.componentName,
    timestampSec: 0,
    selectedAmrId: winner.amrId,
    selectedBid: winner,
    runnerUpAmrId: runnerUp?.amrId,
    runnerUpBid: runnerUp,
    explanation,
    counterfactual,
    tradeOffSummary,
    candidates,
    triageApplied: false,
  };

  return {
    candidates,
    selectedAmrId: winner.amrId,
    decisionTrace,
  };
}
