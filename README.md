# 🚗 LineGuard

### Decentralized Starvation-Risk-Aware Coordination of Autonomous Mobile Robots for Automotive Assembly Logistics

> **Optimize the factory, not the robot.**

## Problem

Modern automotive assembly plants depend on continuous material delivery to keep production stations running.

Stations such as:

- Battery Assembly
- Motor Assembly
- Wiring
- Interior
- Electronics
- Wheel Assembly

operate with limited line-side inventory.

If a critical component arrives late, the station can run out of material and the assembly line may stop.

Traditional AMR coordination commonly focuses on:

- Nearest robot
- Shortest travel time
- FIFO task allocation
- Static priorities
- Centralized scheduling

These approaches optimize individual robot efficiency, but they may not optimize the **overall production line**.

---

## Core Idea

**LineGuard is a decentralized, starvation-aware logistics coordination layer for automotive assembly plants.**

Instead of asking:

> "Which robot can complete this task fastest?"

LineGuard asks:

> **"Which assignment minimizes the overall production impact while preventing station starvation?"**

Each AMR independently evaluates tasks using:

- Starvation risk
- Stockout prediction
- Production impact
- Travel time
- Energy cost
- Congestion
- Capability constraints
- Collateral risk

The best feasible assignment is selected through decentralized bidding.

---

## Factory Simulation

LineGuard simulates an automotive assembly environment containing:

- Multiple production stations
- Central parts warehouse
- Autonomous Mobile Robots (AMRs)
- Charging stations
- Shared factory aisles
- Intersections and congestion
- Different component types
- Different AMR capabilities
- Dynamic material demand

Example:

```text
                 CHARGING
                    │
                    │
        ┌───────────┴───────────┐
        │                       │
   BATTERY                 MOTOR
   STATION                 STATION
        │                       │
        │      FACTORY          │
        │       AISLES          │
        │                       │
   WIRING ───── INTERSECTION ─── ELECTRONICS
        │                       │
        └───────────┬───────────┘
                    │
                 WAREHOUSE
