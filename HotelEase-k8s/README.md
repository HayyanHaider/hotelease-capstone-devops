# HotelEase — Capstone: Task Queues, Background Workers & Custom-Metric Autoscaling

This project extends HotelEase's Kubernetes deployment with asynchronous background job processing — decoupling slow, non-critical work from the main API, and demonstrating horizontal scaling driven by real application load instead of just CPU.

**Builds on:** Docker, Kubernetes (namespaces, deployments, services, PV/PVC, secrets, ingress), and Prometheus/Grafana monitoring from the earlier HotelEase Kubernetes project.

---

## Why This Exists

The original booking-cancellation flow sent confirmation emails inline — inside the same request that handled the cancellation. This worked, but had no reliability guarantees: if the server restarted at the wrong moment, an email could be silently lost, with no retry and no record it was ever supposed to be sent.

Moving this into a task queue adds:
- **Persistence** — jobs survive a crash
- **A foundation for retries** — failed jobs aren't just lost
- **Independent scaling** — the workers processing these jobs scale separately from the main API, based on actual workload

---

## Architecture

```
                     API request (cancel booking)
                              |
                              v
                    +------------------+
                    |  backend (API)   |
                    |  BookingService  |
                    +--------+---------+
                             |  emailQueue.add(...)
                             v
                    +------------------+
                    |  Redis (Queue)   |
                    |  BullMQ backend  |
                    +--------+---------+
                             |  worker pulls jobs
                             v
                    +------------------+
                    |  worker pod(s)   |
                    |  worker.js       |---> MongoDB (booking/user lookup)
                    |  /metrics (9091) |---> Email service (send confirmation)
                    +--------+---------+
                             |  scraped by
                             v
                    +------------------+
                    |   Prometheus     |
                    +--------+---------+
                             |  worker_jobs_processed_total
                             v
                    +------------------+
                    | Prometheus Adapter|
                    +--------+---------+
                             |  custom metric
                             v
                    +------------------+
                    |  HPA (worker)    |  scales worker Deployment 1 -> 5 replicas
                    +------------------+
```

---

## What's Been Built

### 1. Task Queue (Redis + BullMQ)
- Redis deployed both locally (Docker, for early development) and as a Kubernetes Deployment/Service inside the `hotelease` namespace
- `queue.js` defines an `email-confirmation` BullMQ queue, with the Redis connection host/port configurable via environment variables (`REDIS_HOST` / `REDIS_PORT`) — the same code runs identically locally (`localhost`) or inside the cluster (`redis`, resolved via Kubernetes' internal DNS)
- `BookingService.js`'s cancellation flow was refactored: instead of sending the confirmation email inline, it now pushes a job onto the queue and returns immediately

### 2. Background Worker
- `worker.js` — a standalone Node.js process, separate from the main Express API, that listens to the queue and processes `cancellation-email` jobs: looks up the booking/user in MongoDB, builds the email, and sends it
- Runs as its own Docker image (`Dockerfile.worker`), sharing the same codebase/dependencies as the backend but with a different entrypoint

### 3. Process Management (PM2)
- The worker is managed by PM2 locally, giving it automatic restarts on crash and background execution without needing a dedicated terminal — process-level resilience, complementing Kubernetes' pod-level resilience

### 4. Kubernetes Deployment
- `redis-deployment.yml` / `redis-service.yml` — Redis running as a first-class citizen of the cluster
- `worker-deployment.yml` / `worker-service.yml` — the worker running as its own Deployment, connected to MongoDB Atlas, Redis, and email credentials via the existing `backend-secret`

> **Debugging note:** Connecting to Redis via `localhost` works when running the worker directly on a machine, but fails inside a container (`ECONNREFUSED`), since `localhost` inside a pod refers to the pod itself. Fixed by making the Redis host configurable and pointing it at the `redis` Service's DNS name inside the cluster.

### 5. Monitoring
- Installed the `kube-prometheus-stack` (Prometheus + Grafana + Alertmanager) via Helm into a dedicated `monitoring` namespace
- Added `prom-client` to the worker, exposing a `worker_jobs_processed_total` counter (labeled by `completed`/`failed`) on a dedicated `/metrics` endpoint (port 9091), following the same pattern as the backend's existing metrics setup
- Created a `ServiceMonitor` (`worker-servicemonitor.yml`) so Prometheus automatically discovers and scrapes the worker

**Confirmed working — Prometheus successfully scraping the worker's `/metrics` endpoint:**

![Worker metrics target in Prometheus](images/worker-prometheus-target.png)

> **Debugging note:** A `ServiceMonitor`'s `selector` matches based on the target *Service's* labels, not the Service's pod-`selector`. The worker's Service initially had no labels of its own, so Prometheus couldn't find it despite scrapes technically being configured correctly. Fixed by adding `labels: app: worker` to the Service's metadata.

### 6. Custom-Metric Autoscaling
- Installed the Prometheus Adapter via Helm, extending `adapter-values.yml` to also expose `worker_jobs_processed_total` as a Kubernetes custom metric (alongside the backend's existing `http_requests_total`)
- Created `hpa-worker-custom.yml` — an HPA scaling the worker Deployment (1 -> 5 replicas) based on the rate of jobs being processed
- Verified end-to-end with `flood-queue.js`, a load-testing script that pushes a burst of jobs directly onto the queue

**Confirmed working — worker scaling in response to real job load:**

![Worker scaling under load](images/worker-hpa-scaling.png)

*Worker Deployment scaling from 1 to 2 replicas as `worker_jobs_processed_total` climbs, then settling back to 1 once the queue drains and the cooldown window passes.*

---

## Project Structure

```
HotelEase-k8s/
├── backend/
│   ├── queue.js                    (BullMQ queue definition, Redis connection)
│   ├── worker.js                   (standalone background worker + /metrics endpoint)
│   ├── flood-queue.js              (load-testing script for the scaling demo)
│   └── Dockerfile.worker           (separate image for the worker process)
├── k8s/
│   ├── redis-deployment.yml
│   ├── redis-service.yml
│   ├── worker-deployment.yml
│   ├── worker-service.yml
│   ├── worker-servicemonitor.yml
│   └── hpa-worker-custom.yml
├── images/
│   ├── worker-hpa-scaling.png
│   └── worker-prometheus-target.png
```

---

## Run Locally

```bash
# Redis + worker manifests
kubectl apply -f k8s/redis-deployment.yml
kubectl apply -f k8s/redis-service.yml

# build + load the worker image
docker build -f backend/Dockerfile.worker -t hotelease-worker:latest ./backend
kind load docker-image hotelease-worker:latest --name hotelease

kubectl apply -f k8s/worker-deployment.yml
kubectl apply -f k8s/worker-service.yml

# monitoring stack (Prometheus + Grafana)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
kubectl create namespace monitoring
helm install monitoring prometheus-community/kube-prometheus-stack --namespace monitoring

kubectl apply -f k8s/worker-servicemonitor.yml

# Prometheus Adapter (exposes custom metrics to Kubernetes)
helm install prometheus-adapter prometheus-community/prometheus-adapter -n monitoring -f k8s/adapter-values.yml

# worker autoscaling
kubectl apply -f k8s/hpa-worker-custom.yml
```

---

## What This Demonstrates

- Decoupling slow/unreliable work (email sending) from the main request/response cycle using a persistent task queue
- Running a background worker as an independent, containerized process alongside a main API — same codebase, different entrypoint, deployed and scaled separately
- Resilience at two layers: PM2 for process-level auto-restart, Kubernetes for pod-level auto-restart and replica management
- Custom application metrics (not just CPU/memory) driving real autoscaling decisions — the same pattern used in production systems processing background jobs at scale (emails, image processing, video encoding, etc.)

---

## Tech Stack

`Node.js` · `Express` · `MongoDB Atlas` · `Redis` · `BullMQ` · `PM2` · `Docker` · `Kubernetes` · `Prometheus` · `Grafana` · `Helm`
