# 🚗 LineGuard

### Decentralized Starvation-Risk-Aware Coordination of Autonomous Mobile Robots for Automotive Assembly Logistics

> **Optimize the factory, not the robot.**

## 🚨 Problem

In automotive assembly plants, AMRs deliver components to production stations.  
If a critical component arrives late, a station can run out of stock and production may stop.

Traditional approaches such as **FIFO, nearest-robot, or static priority** focus on individual task efficiency rather than overall production impact.

## 💡 Solution

**LineGuard** is a decentralized AMR coordination system that assigns delivery tasks using:

- ⚠️ Starvation Risk
- 🏭 Production Impact
- 🤖 Robot Capability
- 🔋 Energy
- 🚦 Congestion
- 📍 Travel Time
- 🔄 Collateral Risk

Each AMR evaluates tasks locally and submits a bid. The most suitable feasible AMR is selected.

## ⭐ Key Innovation

Instead of asking:

> **Which robot is closest?**

LineGuard asks:

> **Which assignment creates the lowest overall production risk?**

An AMR can lose a task even when it is faster if assigning it creates a higher risk somewhere else in the factory.

## 🔄 Core Workflow

```text
Vehicle Build Sequence
        ↓
Demand Prediction
        ↓
Starvation Risk
        ↓
Production Impact
        ↓
Task Announcement
        ↓
Local AMR Bidding
        ↓
Collateral-Risk Evaluation
        ↓
Task Assignment
        ↓
Delivery & Monitoring
        ↓
Re-auction / Recovery
🏭 Simulation

The prototype models:

Automotive assembly stations
Warehouse
AMR fleet
Charging stations
Factory aisles
Dynamic material demand
Congestion
Robot failures
Communication delays
📊 Evaluation

LineGuard can be compared with:

FIFO
Nearest Robot
Static Priority
Distance-Based Auction
LineGuard
Metrics
Starvation Events
Starvation Duration
On-Time Delivery
Factory Throughput
Task Delay
Energy Consumption
Congestion Delay
Recovery Time
🛠️ Tech Stack

Frontend: React · TypeScript · Vite · Tailwind CSS
Simulation: JavaScript/TypeScript · A* Pathfinding · Decentralized Bidding
Visualization: Recharts · Lucide Icons
