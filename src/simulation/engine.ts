import {
  AMR,
  Station,
  Task,
  Aisle,
  Charger,
  BuildSequenceItem,
  SimEvent,
  FactoryMetrics,
  AllocationPolicy,
  Position,
  DecisionTrace,
} from '../models/types';
import { SeededRNG } from './rng';
import {
  INITIAL_STATIONS,
  INITIAL_AISLES,
  CHARGERS,
  WAREHOUSE,
  calculateManhattanDistance,
} from './factoryLayout';
import { COMPONENTS, VEHICLE_VARIANTS, generateInitialBuildSequence } from './vehicles';
import {
  calculateStockoutMetrics,
  evaluateCandidateBids,
} from './biddingEngine';

export interface SimulationState {
  runId: string;
  seed: number;
  simTimeSec: number;
  policy: AllocationPolicy;
  amrs: AMR[];
  stations: Station[];
  aisles: Aisle[];
  chargers: Charger[];
  tasks: Task[];
  buildSequence: BuildSequenceItem[];
  events: SimEvent[];
  recentDecisions: DecisionTrace[];
  metrics: FactoryMetrics;
  globalStateVersion: number;
  commStatus: 'NORMAL' | 'DELAYED' | 'LOSS';
  disruptionsActive: {
    demandSurge: boolean;
    commDegraded: boolean;
    aisleBlockedId?: string;
    fleetLowBattery: boolean;
  };
}

export function createInitialFleet(seed: number = 82731, count: number = 10): AMR[] {
  const rng = new SeededRNG(seed);
  const amrs: AMR[] = [];

  // Specified initial heterogeneous fleet:
  // AMR-01..10 with AMR-03, AMR-07, AMR-09 being HEAVY capable
  const heavyIds = new Set(['AMR-03', 'AMR-07', 'AMR-09']);

  for (let i = 1; i <= count; i++) {
    const id = `AMR-${i.toString().padStart(2, '0')}`;
    const isHeavy = heavyIds.has(id) || (count > 10 && i % 3 === 0);
    const initialBattery = id === 'AMR-06' ? 39 : id === 'AMR-07' ? 91 : id === 'AMR-09' ? 84 : rng.nextInt(72, 95);

    // Initial scattered positions along aisles
    const posX = 150 + ((i * 75) % 700);
    const posY = (i % 2 === 0 ? 180 : 320) + (rng.nextInt(-20, 20));

    amrs.push({
      id,
      name: `Autonomous Transporter ${id}`,
      payloadCapability: isHeavy ? 'HEAVY' : 'LIGHT',
      maxPayloadKg: isHeavy ? 550 : 120,
      speedMps: isHeavy ? 2.1 : 2.6,
      position: { x: posX, y: posY },
      batteryPct: initialBattery,
      state: initialBattery < 40 ? 'CHARGING' : 'IDLE',
      health: 'HEALTHY',
      commStatus: 'NORMAL',
      stateVersion: 100,
      lastHeartbeatTime: 0,
      totalDistanceTraveled: 0,
      completedTasksCount: 0,
    });
  }

  return amrs;
}

export function createInitialSimulationState(
  seed: number = 82731,
  policy: AllocationPolicy = 'LINEGUARD',
  fleetCount: number = 10
): SimulationState {
  const stations: Station[] = JSON.parse(JSON.stringify(INITIAL_STATIONS));
  const aisles: Aisle[] = JSON.parse(JSON.stringify(INITIAL_AISLES));
  const amrs = createInitialFleet(seed, fleetCount);
  const buildSequence = generateInitialBuildSequence(seed, 25);

  const initialMetrics: FactoryMetrics = {
    simTimeSec: 0,
    activeAmrsCount: 0,
    idleAmrsCount: amrs.length,
    failedAmrsCount: 0,
    criticalDeliveriesCount: 0,
    stationsAtRiskCount: 0,
    totalStarvationEvents: 0,
    totalStarvationDurationSec: 0,
    completedDeliveriesCount: 0,
    onTimeDeliveryRatePct: 100,
    productionLossAvoidedMinutes: 0,
    averageRecoveryTimeSec: 0,
    fleetAverageBatteryPct: Math.round(
      amrs.reduce((sum, a) => sum + a.batteryPct, 0) / amrs.length
    ),
    totalEnergyConsumedPct: 0,
    congestionDelaysSec: 0,
    messagesExchangedCount: 42,
  };

  const initialEvents: SimEvent[] = [
    {
      id: 'EVT-INIT',
      timestampSec: 0,
      type: 'RISK_CHANGED',
      severity: 'INFO',
      title: 'Simulation Initialized',
      description: `LineGuard engine initialized with ${fleetCount} AMRs, 6 stations under policy [${policy}].`,
    },
  ];

  return {
    runId: `RUN-${seed.toString().slice(-4)}`,
    seed,
    simTimeSec: 0,
    policy,
    amrs,
    stations,
    aisles,
    chargers: JSON.parse(JSON.stringify(CHARGERS)),
    tasks: [],
    buildSequence,
    events: initialEvents,
    recentDecisions: [],
    metrics: initialMetrics,
    globalStateVersion: 101,
    commStatus: 'NORMAL',
    disruptionsActive: {
      demandSurge: false,
      commDegraded: false,
      fleetLowBattery: false,
    },
  };
}

let taskIdCounter = 1040;
let eventIdCounter = 1;

/**
 * Steps the simulation forward by dt seconds (typically 1.0 second)
 */
export function stepSimulation(state: SimulationState, dt: number = 1.0): SimulationState {
  const next = { ...state };
  next.simTimeSec = Math.round((next.simTimeSec + dt) * 10) / 10;
  next.globalStateVersion += 1;

  const currentSimTime = next.simTimeSec;
  const newEvents: SimEvent[] = [];

  // 1. Advance Active Build Sequence and Compute Consumption Rates
  // Vehicle moves forward every 40-50 seconds
  const currentVehicleIndex = Math.floor(currentSimTime / 45) % next.buildSequence.length;
  const activeVehicle = next.buildSequence[currentVehicleIndex];
  const variant = VEHICLE_VARIANTS.find((v) => v.id === activeVehicle.vehicleVariantId) || VEHICLE_VARIANTS[0];

  // 2. Update Stations: Inventory consumption, Stockout calculations
  let stationsAtRisk = 0;
  const updatedStations = next.stations.map((st) => {
    const station = { ...st };

    // Dynamic consumption rate based on active vehicle variant + demand surge
    const mult = (variant.multiplier[station.componentRequired] || 1.0) * (next.disruptionsActive.demandSurge ? 1.5 : 1.0);
    station.consumptionRate = Math.round(station.nominalRate * mult * 1000) / 1000;

    // Drain inventory
    station.currentInventory = Math.max(0, station.currentInventory - station.consumptionRate * dt);

    // Staleness increases if communication is degraded
    if (next.commStatus === 'DELAYED') {
      station.stalenessAgeSec = Math.min(25, station.stalenessAgeSec + dt);
    } else if (next.commStatus === 'LOSS') {
      station.stalenessAgeSec = Math.min(60, station.stalenessAgeSec + dt * 1.5);
    } else {
      station.stalenessAgeSec = Math.max(0.5, station.stalenessAgeSec * 0.85);
    }

    // Uncertainty-aware stockout prediction
    const { predictedStockoutSec, starvationProb } = calculateStockoutMetrics(station);
    station.predictedStockoutSec = predictedStockoutSec;
    station.starvationProbability = starvationProb;

    // Check Starvation state
    if (station.currentInventory <= 0.01) {
      if (!station.isStarved) {
        station.isStarved = true;
        next.metrics.totalStarvationEvents += 1;
        newEvents.push({
          id: `EVT-${eventIdCounter++}`,
          timestampSec: currentSimTime,
          type: 'RISK_CHANGED',
          stationId: station.id,
          severity: 'CRITICAL',
          title: `STARVATION EVENT: ${station.name}`,
          description: `Line starved! Zero stock of ${station.componentName}. Production halted.`,
        });
      }
      station.starvationDurationSec += dt;
      next.metrics.totalStarvationDurationSec += dt;
    } else {
      station.isStarved = false;
    }

    if (station.predictedStockoutSec < 60) {
      stationsAtRisk++;
    }

    return station;
  });

  next.stations = updatedStations;
  next.metrics.stationsAtRiskCount = stationsAtRisk;

  // 3. Check for New Delivery Task Requirements
  for (const station of next.stations) {
    // If inventory buffer low (< 45 sec stockout or < safety stock) and no active pending/transit task assigned
    const hasActiveTask = next.tasks.some(
      (t) => t.stationId === station.id && (t.status === 'ASSIGNED' || t.status === 'IN_TRANSIT' || t.status === 'PENDING_AUCTION')
    );

    if (!hasActiveTask && (station.predictedStockoutSec < 50 || station.currentInventory <= station.safetyStock)) {
      taskIdCounter++;
      const newTask: Task = {
        id: `TASK-${taskIdCounter}`,
        stationId: station.id,
        componentId: station.componentRequired,
        quantity: station.payloadRequirement === 'HEAVY' ? 4 : 8,
        payloadRequirement: station.payloadRequirement,
        isRescue: false,
        creationTimeSec: currentSimTime,
        urgencyLevel: station.criticality >= 0.9 ? 'CRITICAL' : station.criticality >= 0.7 ? 'HIGH' : 'MEDIUM',
        status: 'PENDING_AUCTION',
        bids: [],
        deadlineSimTime: currentSimTime + station.predictedStockoutSec,
      };

      newEvents.push({
        id: `EVT-${eventIdCounter++}`,
        timestampSec: currentSimTime,
        type: 'TASK_ANNOUNCED',
        taskId: newTask.id,
        stationId: station.id,
        severity: 'INFO',
        title: `Task Announced: ${newTask.id}`,
        description: `Material call for ${station.name} (${station.componentName}). Predicted stockout: ${Math.round(station.predictedStockoutSec)}s.`,
      });

      // Execute Decentralized Auction
      const auctionResult = evaluateCandidateBids(
        newTask,
        station,
        next.stations,
        next.amrs,
        next.aisles,
        next.policy
      );

      newTask.bids = auctionResult.candidates;
      next.metrics.messagesExchangedCount += next.amrs.length * 2; // Request + Bid messages

      if (auctionResult.selectedAmrId) {
        newTask.status = 'ASSIGNED';
        newTask.assignedAmrId = auctionResult.selectedAmrId;
        newTask.decisionTrace = auctionResult.decisionTrace;

        // Create Lease (16 seconds duration)
        newTask.lease = {
          taskId: newTask.id,
          amrId: auctionResult.selectedAmrId,
          leaseDurationSec: 16,
          assignedSimTime: currentSimTime,
          expiresAtSimTime: currentSimTime + 16,
        };

        // If station has high criticality (>= 0.8), designate hot-standby AMR if candidate exists
        if (station.criticality >= 0.8 && auctionResult.candidates.length > 1) {
          const standbyCandidate = auctionResult.candidates
            .filter((c) => c.eligible && c.amrId !== auctionResult.selectedAmrId)
            .sort((a, b) => a.totalScore - b.totalScore)[0];

          if (standbyCandidate) {
            newTask.standbyAmrId = standbyCandidate.amrId;
            newEvents.push({
              id: `EVT-${eventIdCounter++}`,
              timestampSec: currentSimTime,
              type: 'STANDBY_ASSIGNED',
              taskId: newTask.id,
              amrId: standbyCandidate.amrId,
              severity: 'INFO',
              title: `Hot Standby Assigned: ${standbyCandidate.amrId}`,
              description: `Critical task ${newTask.id} protected by standby AMR ${standbyCandidate.amrId}.`,
            });
          }
        }

        // Update assigned AMR state
        const assignedAmr = next.amrs.find((a) => a.id === auctionResult.selectedAmrId);
        if (assignedAmr) {
          assignedAmr.state = 'MOVING_TO_PICKUP';
          assignedAmr.currentTaskId = newTask.id;
          assignedAmr.targetPosition = WAREHOUSE.position;
          assignedAmr.lastHeartbeatTime = currentSimTime;
        }

        if (auctionResult.decisionTrace) {
          next.recentDecisions = [auctionResult.decisionTrace, ...next.recentDecisions.slice(0, 19)];
        }

        newEvents.push({
          id: `EVT-${eventIdCounter++}`,
          timestampSec: currentSimTime,
          type: 'AMR_SELECTED',
          taskId: newTask.id,
          amrId: auctionResult.selectedAmrId,
          severity: 'SUCCESS',
          title: `Contract Awarded: ${auctionResult.selectedAmrId}`,
          description: `Assigned to ${auctionResult.selectedAmrId}. ${auctionResult.decisionTrace?.explanation || ''}`,
        });
      } else {
        // Triage: No feasible robot
        newEvents.push({
          id: `EVT-${eventIdCounter++}`,
          timestampSec: currentSimTime,
          type: 'TRIAGE_ENACTED',
          taskId: newTask.id,
          stationId: station.id,
          severity: 'CRITICAL',
          title: `TRIAGE: No Feasible AMR for ${station.name}`,
          description: `All AMRs failed payload or battery gates. Station will enter starvation.`,
        });
      }

      next.tasks.push(newTask);
    }
  }

  // 4. Update AMR Movements, Battery, Heartbeats & Task Progress
  const updatedAmrs = next.amrs.map((a) => {
    const amr = { ...a };

    // Communication degradation handling
    amr.commStatus = next.commStatus;
    if (next.commStatus === 'NORMAL') {
      amr.stateVersion = next.globalStateVersion;
    } else if (next.commStatus === 'DELAYED') {
      // Lag by 4-8 state versions
      amr.stateVersion = Math.max(100, next.globalStateVersion - 6);
    } else {
      // Frozen/loss
      amr.stateVersion = Math.max(100, next.globalStateVersion - 18);
    }

    // If AMR is FAILED
    if (amr.health === 'FAILED') {
      amr.state = 'FAILED';
      return amr;
    }

    // Heartbeat update
    amr.lastHeartbeatTime = currentSimTime;

    // Movement helper
    const moveTowards = (target: Position, speed: number) => {
      const dx = target.x - amr.position.x;
      const dy = target.y - amr.position.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 4) {
        amr.position = { ...target };
        return true; // arrived
      }

      const moveDist = Math.min(dist, speed * 12 * dt); // coordinate scaling factor
      amr.position = {
        x: Math.round((amr.position.x + (dx / dist) * moveDist) * 10) / 10,
        y: Math.round((amr.position.y + (dy / dist) * moveDist) * 10) / 10,
      };
      amr.totalDistanceTraveled += moveDist * 0.25;

      // Battery drain while moving (higher if carrying heavy payload)
      const drainFactor = amr.payloadCapability === 'HEAVY' ? 0.08 : 0.05;
      amr.batteryPct = Math.max(0, Math.round((amr.batteryPct - drainFactor * dt) * 10) / 10);
      next.metrics.totalEnergyConsumedPct += drainFactor * dt;

      return false;
    };

    // State Machine
    if (amr.state === 'CHARGING') {
      const charger = next.chargers[0];
      moveTowards(charger.position, amr.speedMps);
      amr.batteryPct = Math.min(100, Math.round((amr.batteryPct + charger.chargeRatePctPerSec * dt) * 10) / 10);
      if (amr.batteryPct >= 95) {
        amr.state = 'IDLE';
        amr.targetPosition = undefined;
      }
    } else if (amr.state === 'IDLE') {
      // Auto-recharge if battery falls below 25%
      if (amr.batteryPct < 25) {
        amr.state = 'CHARGING';
        amr.targetPosition = next.chargers[0].position;
      }
    } else if (amr.state === 'MOVING_TO_PICKUP') {
      const activeTask = next.tasks.find((t) => t.id === amr.currentTaskId);
      const targetPos = activeTask?.isRescue && activeTask.rescuePayloadLocation
        ? activeTask.rescuePayloadLocation
        : WAREHOUSE.position;

      const arrived = moveTowards(targetPos, amr.speedMps);
      if (arrived) {
        amr.state = 'LOADING';
      }
    } else if (amr.state === 'LOADING') {
      // Loading duration
      amr.state = 'DELIVERING';
      const activeTask = next.tasks.find((t) => t.id === amr.currentTaskId);
      if (activeTask) {
        activeTask.status = 'IN_TRANSIT';
        amr.carryingComponentId = activeTask.componentId;
        const station = next.stations.find((s) => s.id === activeTask.stationId);
        if (station) {
          amr.targetPosition = station.position;
        }
      }
    } else if (amr.state === 'DELIVERING') {
      const activeTask = next.tasks.find((t) => t.id === amr.currentTaskId);
      const station = next.stations.find((s) => s.id === activeTask?.stationId);
      const targetPos = station ? station.position : WAREHOUSE.position;

      const arrived = moveTowards(targetPos, amr.speedMps);
      if (arrived && activeTask && station) {
        amr.state = 'UNLOADING';
      }
    } else if (amr.state === 'UNLOADING') {
      // Unload payload and complete task
      const activeTask = next.tasks.find((t) => t.id === amr.currentTaskId);
      const station = next.stations.find((s) => s.id === activeTask?.stationId);

      if (activeTask && station) {
        activeTask.status = 'DELIVERED';
        activeTask.completionSimTime = currentSimTime;

        // Replenish buffer
        station.currentInventory = Math.min(station.maxBuffer, station.currentInventory + activeTask.quantity);
        station.isStarved = false;

        const onTime = currentSimTime <= activeTask.deadlineSimTime;
        next.metrics.completedDeliveriesCount += 1;
        if (onTime) {
          next.metrics.productionLossAvoidedMinutes += Math.round(station.criticality * 2.8 * 10) / 10;
        }

        newEvents.push({
          id: `EVT-${eventIdCounter++}`,
          timestampSec: currentSimTime,
          type: 'DELIVERY_COMPLETED',
          taskId: activeTask.id,
          stationId: station.id,
          amrId: amr.id,
          severity: 'SUCCESS',
          title: `Delivery Completed: ${activeTask.id}`,
          description: `AMR ${amr.id} delivered ${activeTask.quantity} units to ${station.name}. Buffer restored to ${station.currentInventory.toFixed(1)} units.`,
        });
      }

      amr.state = amr.batteryPct < 30 ? 'CHARGING' : 'IDLE';
      amr.currentTaskId = undefined;
      amr.carryingComponentId = undefined;
      amr.targetPosition = undefined;
      amr.completedTasksCount += 1;
    }

    return amr;
  });

  next.amrs = updatedAmrs;

  // 5. Manage Task Leases & Heartbeat Timeouts
  for (const task of next.tasks) {
    if (task.status === 'ASSIGNED' || task.status === 'IN_TRANSIT') {
      const assignedAmr = next.amrs.find((a) => a.id === task.assignedAmrId);

      // Check if assigned AMR has failed or lease expired
      const amrFailed = assignedAmr && assignedAmr.health === 'FAILED';
      const leaseExpired = task.lease && currentSimTime > task.lease.expiresAtSimTime && task.status !== 'IN_TRANSIT';

      if (amrFailed || leaseExpired) {
        newEvents.push({
          id: `EVT-${eventIdCounter++}`,
          timestampSec: currentSimTime,
          type: amrFailed ? 'AMR_FAILED' : 'LEASE_EXPIRED',
          taskId: task.id,
          amrId: task.assignedAmrId,
          severity: 'WARNING',
          title: amrFailed ? `AMR Failure: ${task.assignedAmrId}` : `Lease Expired: ${task.id}`,
          description: `Contract with ${task.assignedAmrId} cancelled. Activating decentralized recovery.`,
        });

        // Check if Hot Standby is ready
        if (task.standbyAmrId) {
          const standbyAmr = next.amrs.find((a) => a.id === task.standbyAmrId);
          if (standbyAmr && standbyAmr.health === 'HEALTHY' && standbyAmr.state === 'IDLE') {
            task.assignedAmrId = task.standbyAmrId;
            task.standbyAmrId = undefined;
            task.lease = {
              taskId: task.id,
              amrId: standbyAmr.id,
              leaseDurationSec: 16,
              assignedSimTime: currentSimTime,
              expiresAtSimTime: currentSimTime + 16,
            };
            standbyAmr.state = 'MOVING_TO_PICKUP';
            standbyAmr.currentTaskId = task.id;
            standbyAmr.targetPosition = WAREHOUSE.position;

            newEvents.push({
              id: `EVT-${eventIdCounter++}`,
              timestampSec: currentSimTime,
              type: 'AMR_SELECTED',
              taskId: task.id,
              amrId: standbyAmr.id,
              severity: 'SUCCESS',
              title: `Hot Standby Engaged: ${standbyAmr.id}`,
              description: `Zero-delay failover! Standby ${standbyAmr.id} took over task ${task.id}.`,
            });
            continue;
          }
        }

        // Re-auction task among remaining AMRs
        const station = next.stations.find((s) => s.id === task.stationId);
        if (station) {
          task.status = 'PENDING_AUCTION';
          task.assignedAmrId = undefined;
          task.lease = undefined;

          const reAuctionResult = evaluateCandidateBids(
            task,
            station,
            next.stations,
            next.amrs,
            next.aisles,
            next.policy
          );

          if (reAuctionResult.selectedAmrId) {
            task.status = 'ASSIGNED';
            task.assignedAmrId = reAuctionResult.selectedAmrId;
            task.lease = {
              taskId: task.id,
              amrId: reAuctionResult.selectedAmrId,
              leaseDurationSec: 16,
              assignedSimTime: currentSimTime,
              expiresAtSimTime: currentSimTime + 16,
            };
            const newWinner = next.amrs.find((a) => a.id === reAuctionResult.selectedAmrId);
            if (newWinner) {
              newWinner.state = 'MOVING_TO_PICKUP';
              newWinner.currentTaskId = task.id;
              newWinner.targetPosition = WAREHOUSE.position;
            }

            newEvents.push({
              id: `EVT-${eventIdCounter++}`,
              timestampSec: currentSimTime,
              type: 'RE_AUCTION',
              taskId: task.id,
              amrId: reAuctionResult.selectedAmrId,
              severity: 'SUCCESS',
              title: `Re-Auction Successful: ${reAuctionResult.selectedAmrId}`,
              description: `Task ${task.id} reassigned to ${reAuctionResult.selectedAmrId}.`,
            });
          }
        }
      }
    }
  }

  // 6. Update Aisle Congestion
  const updatedAisles = next.aisles.map((aisle) => {
    // Count AMRs currently within proximity of this aisle
    let countInAisle = 0;
    const minY = Math.min(aisle.start.y, aisle.end.y) - 40;
    const maxY = Math.max(aisle.start.y, aisle.end.y) + 40;
    const minX = Math.min(aisle.start.x, aisle.end.x) - 40;
    const maxX = Math.max(aisle.start.x, aisle.end.x) + 40;

    for (const amr of next.amrs) {
      if (
        amr.position.x >= minX &&
        amr.position.x <= maxX &&
        amr.position.y >= minY &&
        amr.position.y <= maxY &&
        amr.health === 'HEALTHY'
      ) {
        countInAisle++;
      }
    }

    const congestionLevel = Math.min(1.0, countInAisle / Math.max(1, aisle.capacity));
    return {
      ...aisle,
      currentCount: countInAisle,
      congestionLevel: Math.round(congestionLevel * 100) / 100,
    };
  });
  next.aisles = updatedAisles;

  // 7. Aggregate Metrics
  const activeCount = next.amrs.filter((a) => a.state !== 'IDLE' && a.state !== 'FAILED').length;
  const idleCount = next.amrs.filter((a) => a.state === 'IDLE').length;
  const failedCount = next.amrs.filter((a) => a.health === 'FAILED').length;
  const avgBattery = Math.round(next.amrs.reduce((sum, a) => sum + a.batteryPct, 0) / next.amrs.length);

  next.metrics = {
    ...next.metrics,
    simTimeSec: next.simTimeSec,
    activeAmrsCount: activeCount,
    idleAmrsCount: idleCount,
    failedAmrsCount: failedCount,
    fleetAverageBatteryPct: avgBattery,
    criticalDeliveriesCount: next.tasks.filter((t) => t.urgencyLevel === 'CRITICAL' && t.status !== 'DELIVERED').length,
    onTimeDeliveryRatePct:
      next.metrics.completedDeliveriesCount > 0
        ? Math.round(
            (next.tasks.filter((t) => t.status === 'DELIVERED' && (t.completionSimTime || 0) <= t.deadlineSimTime).length /
              next.metrics.completedDeliveriesCount) *
              100
          )
        : 100,
  };

  next.events = [...newEvents, ...next.events].slice(0, 100);

  return next;
}

/**
 * Disruption Injections
 */
export function injectDisruption(
  state: SimulationState,
  type:
    | 'DEMAND_SURGE'
    | 'AMR_FAILURE'
    | 'COMM_DELAY'
    | 'COMM_LOSS'
    | 'COMM_RESTORE'
    | 'AISLE_BLOCK'
    | 'LOW_BATTERY'
    | 'HEAVY_UNAVAILABLE'
): SimulationState {
  const next = { ...state };
  const currentSimTime = next.simTimeSec;
  const newEvents: SimEvent[] = [];

  switch (type) {
    case 'DEMAND_SURGE': {
      next.disruptionsActive.demandSurge = true;
      newEvents.push({
        id: `EVT-${eventIdCounter++}`,
        timestampSec: currentSimTime,
        type: 'DISRUPTION_INJECTED',
        severity: 'WARNING',
        title: 'DISRUPTION: EV SUV Production Surge',
        description: 'Traction battery and dual motor consumption rate increased by +80% across assembly line.',
      });
      break;
    }

    case 'AMR_FAILURE': {
      // Find an active delivering AMR or random AMR
      const targetAmr =
        next.amrs.find((a) => a.state === 'DELIVERING' && a.health === 'HEALTHY') ||
        next.amrs.find((a) => a.health === 'HEALTHY' && a.id === 'AMR-07') ||
        next.amrs.find((a) => a.health === 'HEALTHY');

      if (targetAmr) {
        targetAmr.health = 'FAILED';
        targetAmr.state = 'FAILED';

        // If carrying component, drop component as a RESCUE TASK
        if (targetAmr.carryingComponentId) {
          taskIdCounter++;
          const rescueTask: Task = {
            id: `TASK-RESCUE-${taskIdCounter}`,
            stationId: targetAmr.currentTaskId
              ? next.tasks.find((t) => t.id === targetAmr.currentTaskId)?.stationId || 'ST-BAT'
              : 'ST-BAT',
            componentId: targetAmr.carryingComponentId,
            quantity: 4,
            payloadRequirement: 'HEAVY',
            isRescue: true,
            rescuePayloadLocation: { ...targetAmr.position },
            originalFailedAmrId: targetAmr.id,
            creationTimeSec: currentSimTime,
            urgencyLevel: 'CRITICAL',
            status: 'PENDING_AUCTION',
            bids: [],
            deadlineSimTime: currentSimTime + 65,
          };
          next.tasks.push(rescueTask);

          newEvents.push({
            id: `EVT-${eventIdCounter++}`,
            timestampSec: currentSimTime,
            type: 'RESCUE_TASK_CREATED',
            amrId: targetAmr.id,
            taskId: rescueTask.id,
            severity: 'CRITICAL',
            title: `CARGO STRANDED: Rescue Task ${rescueTask.id}`,
            description: `${targetAmr.id} suffered catastrophic actuator fault at (${targetAmr.position.x}, ${targetAmr.position.y}) while hauling ${COMPONENTS[targetAmr.carryingComponentId]?.name || 'cargo'}. Rescue auction initiated.`,
          });
        } else {
          newEvents.push({
            id: `EVT-${eventIdCounter++}`,
            timestampSec: currentSimTime,
            type: 'AMR_FAILED',
            amrId: targetAmr.id,
            severity: 'CRITICAL',
            title: `HARDWARE FAILURE: ${targetAmr.id}`,
            description: `${targetAmr.id} experienced emergency e-stop fault. Removed from active fleet.`,
          });
        }
      }
      break;
    }

    case 'COMM_DELAY': {
      next.commStatus = 'DELAYED';
      next.disruptionsActive.commDegraded = true;
      newEvents.push({
        id: `EVT-${eventIdCounter++}`,
        timestampSec: currentSimTime,
        type: 'COMMUNICATION_DEGRADED',
        severity: 'WARNING',
        title: 'NETWORK DISRUPTION: High Latency Delay',
        description: 'Shopfloor Wi-Fi / Private 5G packet latency increased to 3,200ms. AMRs operating with stale state versions.',
      });
      break;
    }

    case 'COMM_LOSS': {
      next.commStatus = 'LOSS';
      next.disruptionsActive.commDegraded = true;
      newEvents.push({
        id: `EVT-${eventIdCounter++}`,
        timestampSec: currentSimTime,
        type: 'COMMUNICATION_DEGRADED',
        severity: 'CRITICAL',
        title: 'NETWORK DISRUPTION: Partial Communication Loss',
        description: 'AP outage in East Bay. AMRs relying strictly on decentralized peer caches and high uncertainty margins.',
      });
      break;
    }

    case 'COMM_RESTORE': {
      next.commStatus = 'NORMAL';
      next.disruptionsActive.commDegraded = false;
      newEvents.push({
        id: `EVT-${eventIdCounter++}`,
        timestampSec: currentSimTime,
        type: 'COMMUNICATION_DEGRADED',
        severity: 'SUCCESS',
        title: 'NETWORK RESTORED: Nominal Connectivity',
        description: 'Full low-latency mesh communications re-established across all fleet nodes.',
      });
      break;
    }

    case 'AISLE_BLOCK': {
      const aisle = next.aisles.find((a) => !a.isBlocked) || next.aisles[1];
      aisle.isBlocked = !aisle.isBlocked;
      newEvents.push({
        id: `EVT-${eventIdCounter++}`,
        timestampSec: currentSimTime,
        type: 'DISRUPTION_INJECTED',
        severity: aisle.isBlocked ? 'WARNING' : 'INFO',
        title: aisle.isBlocked ? `AISLE OBSTRUCTION: ${aisle.name}` : `Aisle Cleared: ${aisle.name}`,
        description: aisle.isBlocked
          ? `Spill / maintenance barrier in ${aisle.name}. AMRs rerouting through secondary corridors.`
          : `${aisle.name} reopened for nominal traffic.`,
      });
      break;
    }

    case 'LOW_BATTERY': {
      next.disruptionsActive.fleetLowBattery = true;
      for (const amr of next.amrs) {
        if (amr.health === 'HEALTHY') {
          amr.batteryPct = Math.max(12, Math.round(amr.batteryPct * 0.35));
        }
      }
      newEvents.push({
        id: `EVT-${eventIdCounter++}`,
        timestampSec: currentSimTime,
        type: 'DISRUPTION_INJECTED',
        severity: 'WARNING',
        title: 'FLEET DISRUPTION: Low Battery Stress Test',
        description: 'Shift change battery depletion simulated. AMRs with insufficient reserves fail feasibility gates.',
      });
      break;
    }

    case 'HEAVY_UNAVAILABLE': {
      for (const amr of next.amrs) {
        if (amr.payloadCapability === 'HEAVY') {
          amr.batteryPct = 14; // too low for heavy deliveries
        }
      }
      newEvents.push({
        id: `EVT-${eventIdCounter++}`,
        timestampSec: currentSimTime,
        type: 'DISRUPTION_INJECTED',
        severity: 'CRITICAL',
        title: 'SCARCITY EVENT: Heavy AMR Depletion',
        description: 'All heavy-capable AMRs pushed to low-battery states. Scarcity penalty and explicit triage activated.',
      });
      break;
    }
  }

  next.events = [...newEvents, ...next.events].slice(0, 100);
  return next;
}
