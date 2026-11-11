# Presentation Script and Q&A Preparation

**Hospital Appointment & Queue Management System**

Building Enterprise Applications (BCS703B)  
CCA Phase 1

Guide: Poornima G J, Assistant Professor

## Speaking plan

The prepared speaking track is 12 minutes, with roughly one minute available for slide transitions and natural pauses. Rehearse for 13 minutes. Questions are additional unless the panel includes them in the same time limit. No script can prevent questions; give a direct answer before referring to a backup slide.

Slides 1–21 form the main talk. Slides 22–32 contain all 32 references and should not be read aloud individually. Slide 33 is the closing discussion slide. Slides 34–39 contain additional detail for questions. Use the slide-number box in Presenter View to jump to a backup slide.

**Rishab Paul: 02:10 of planned speaking time.**

**Rahul Sonar: 02:35 of planned speaking time.**

**Rohan Balu: 03:35 of planned speaking time.**

**Rohan Bharat: 03:40 of planned speaking time.**

## Before presenting

Keep this script in Presenter View or on a separate device. The PPT notes contain the same main speaking text.

Read complete ideas naturally; do not recite every on-screen bullet as a separate sentence. Pause on each full-slide diagram, then move to its explanation slide.

Use proposal language: “we propose,” “we plan to test” and “the target is.” No hospital deployment, measured improvement or benchmark pass is claimed.

If asked about a figure, explain the records or components and the meaning of each arrow. If asked about a number, distinguish a planning assumption from a measured result.

# Timed presentation script

## Slide 1. Hospital Appointment & Queue Management System

**Rishab Paul \| 00:00–00:20 \| 20 seconds**

Good morning, ma’am and respected panel members. We are presenting our Hospital Appointment and Queue Management System for Building Enterprise Applications, under the guidance of Assistant Professor Poornima G J. This is our Phase 1 design proposal. We will explain the problem, queue algorithm, architecture and planned evaluation.

## Slide 2. Abstract

**Rishab Paul \| 00:20–00:55 \| 35 seconds**

Our project coordinates the patient journey from booking to consultation and follow-up. Booking reserves capacity, while the queue determines which eligible patient should be called next. The add-on connects verified instructions with staff-owned follow-up. Our present outcome is a detailed design and evaluation plan.

## Slide 3. Introduction and Motivation

**Rishab Paul \| 00:55–01:30 \| 35 seconds**

A hospital must coordinate people who booked ahead and people who arrive without bookings. Consultation durations also vary. This creates different responsibilities for reception, doctors and follow-up staff. Research shows that scheduling choices depend on operational assumptions. For BEA, our contribution is to model these responsibilities explicitly and preserve consistency when several users change shared records.

## Slide 4. Problem Statement and Scope

**Rishab Paul \| 01:30–02:10 \| 40 seconds**

The specific problem is keeping reservations, actual attendance and doctor allocation consistent. If two staff members book the final place together, only one reservation should succeed. Similarly, two call-next requests must not allocate two patients to the same doctor. Our scope is outpatient appointments and consultation queues in one hospital. Rahul will explain the requirements and queue method.

## Slide 5. Objectives and Requirements

**Rahul Sonar \| 02:10–02:50 \| 40 seconds**

Our requirements cover complete operations rather than isolated screens. An appointment change must update capacity correctly; a check-in must create only one visit and queue entry. Every queue decision must record its reason. The non-functional requirements address response time, consistency, recovery and authorized access. The report links these requirements to tests so that implementation can be evaluated against clear criteria.

## Slide 6. Proposed Methodology

**Rahul Sonar \| 02:50–03:30 \| 40 seconds**

We follow a requirements-first method. We define records and valid transitions, estimate the workload, then specify the queue rules. The four architectural views describe the same system from different perspectives. Implementation will start with identity and capacity integrity, followed by queues and the add-on. Evaluation will use synthetic data with recorded scenarios. We will compare policies on the same arrivals and service durations, including overloaded cases.

## Slide 7. Queue Management Algorithm

**Rahul Sonar \| 03:30–03:40 \| 10 seconds**

This flowchart shows selection order. Eligibility is checked first, followed by authorized clinical priority, aging and the normal appointment-to-walk-in rotation.

Presenter cue: Trace the component or selection order briefly. Give the detailed explanation on the next slide.

## Slide 8. Queue Algorithm Explanation

**Rahul Sonar \| 03:40–04:45 \| 65 seconds**

The algorithm has three selection levels after eligibility. Clinical priority must be assigned by an authorized clinical actor. If no such candidate exists, the oldest eligible patient who has waited at least forty-five minutes is selected. Otherwise, the normal cycle is two appointments followed by one walk-in. Empty groups are skipped without saving credits, and overrides leave the normal pointer unchanged. Appointment ties use scheduled time, check-in time and a stable sequence; walk-ins use accepted check-in time and sequence. A consultation already running is never interrupted. The ratio and aging threshold are configurable project choices, not values proved optimal by research. A linear scan takes O of n time at our small session size. Rohan Balu will explain the architecture.

## Slide 9. Logical Architecture

**Rohan Balu \| 04:45–04:55 \| 10 seconds**

The logical view shows the user interfaces, authorization layer, core modules and shared application services.

Presenter cue: Trace the component or selection order briefly. Give the detailed explanation on the next slide.

## Slide 10. Logical Architecture Explanation

**Rohan Balu \| 04:55–05:30 \| 35 seconds**

Each role receives an appropriate interface, but permissions are enforced on the server. For example, a reception account cannot verify clinical instructions, and a patient cannot open another patient’s document. The backend is a modular monolith: modules are separated in code but deployed together. This keeps core transactions local and reduces operational complexity at our planned scale.

## Slide 11. Technical Architecture

**Rohan Balu \| 05:30–05:40 \| 10 seconds**

The technical view shows request handling, committed database changes, background jobs and live queue updates.

Presenter cue: Trace the component or selection order briefly. Give the detailed explanation on the next slide.

## Slide 12. Technical Architecture Explanation

**Rohan Balu \| 05:40–06:40 \| 60 seconds**

Consider two requests for the last appointment place. The first transaction acquires the capacity guard, rechecks capacity and commits. The next transaction then sees the updated state and returns a controlled conflict. Call-next also locks a doctor-level guard, because locking separate queue rows alone would still allow two allocations. Locks last only for the short transaction, not for the consultation. An idempotency key identifies a repeated operation after a lost response. Slow OCR or model calls run in background workers. Durable delivery is at least once, so handlers must tolerate retries. Server-Sent Events provide live updates, with an authoritative snapshot after reconnection.

## Slide 13. Data Architecture

**Rohan Balu \| 06:40–06:50 \| 10 seconds**

The data view separates patient identity, the reservation, actual attendance, the queue entry and follow-up responsibility.

Presenter cue: Trace the component or selection order briefly. Give the detailed explanation on the next slide.

## Slide 14. Data Architecture Explanation

**Rohan Balu \| 06:50–07:30 \| 40 seconds**

The important distinction is that one token cannot represent every lifecycle. A booking can exist before attendance, while a walk-in can attend without an earlier booking. A skipped call reuses its queue entry. A later return consultation is a new appointment and visit linked to the follow-up task. Database constraints protect identity and relationships, while transactions protect totals shared across several records.

## Slide 15. Infrastructure Architecture

**Rohan Balu \| 07:30–07:40 \| 10 seconds**

The infrastructure view separates browser access, the application host, managed database, private documents and external processing providers.

Presenter cue: Trace the component or selection order briefly. Give the detailed explanation on the next slide.

## Slide 16. Infrastructure Architecture Explanation

**Rohan Balu \| 07:40–08:20 \| 40 seconds**

We will use local Docker for the college demonstration and a separately c

hosted Google Cloud environment for hosted evaluation. Compute Engine runs the application and workers; Cloud SQL provides PostgreSQL, and Cloud Storage holds private documents. The initial application host is a single failure point, so we do not claim high availability simply because containers are separated. Backup configuration and a complete restore exercise are required. Rohan Bharat will explain the follow-up add-on, feasibility and evaluation.

## Slide 17. MediBridge-Inspired Follow-Up

**Rohan Bharat \| 08:20–09:10 \| 50 seconds**

The add-on closes an operational follow-up loop. OCR extracts draft text from a document, and an authorized reviewer verifies it. The assistant can then explain the verified context for that patient. If context is missing or a question is unsupported, it creates a staff task. A task is closed only through a recorded disposition or cancellation. If a return consultation is needed, staff arrange a new capacity-checked appointment. We do not treat OCR accuracy or a source reference as proof of clinical safety, and the assistant cannot prescribe treatment or grant clinical priority.

## Slide 18. Tools and Technology Justification

**Rohan Bharat \| 09:10–09:45 \| 35 seconds**

Our stack follows the consistency requirements. PostgreSQL fits linked records and atomic changes, while NestJS gives clear module boundaries. Server-Sent Events fit queue notifications because the main direction is server to client. Database-backed jobs are sufficient for the planned workload. Vision supplies OCR, while the model remains behind an adapter so cost or lifecycle changes do not require redesigning core workflows.

## Slide 19. Workload and Feasibility

**Rohan Bharat \| 09:45–10:30 \| 45 seconds**

These figures are planning assumptions rather than hospital measurements. Twenty sessions with fifteen places each give three hundred daily visits. After breaks, doctors provide four thousand two hundred minutes; at twelve minutes per visit, demand is three thousand six hundred minutes. That is eighty-five point seven percent utilization. If average consultations rise to sixteen minutes, demand exceeds capacity. Queue ordering cannot create doctor time. Server throughput also cannot be inferred from the number of patients; it requires a defined load test.

## Slide 20. Evaluation and Expected Outcomes

**Rohan Bharat \| 10:30–11:20 \| 50 seconds**

We will evaluate correctness before claiming performance. A hundred requests per second for thirty minutes is our sustained test target, with ordinary API p95 latency within five hundred milliseconds. P95 means ninety-five percent of measured requests are at or below that value. We also test bursts and queue freshness. Queue simulations compare waiting and utilization with first-come, first-served using identical workloads. Recovery targets are fifteen minutes of recoverable data loss and sixty minutes to restore service, verified through an exercise. None of these values is an achieved result today.

## Slide 21. Work Plan and Conclusion

**Rohan Bharat \| 11:20–12:00 \| 40 seconds**

Implementation follows dependencies: appointments and capacity first, then queues, then the add-on. Our base effort estimate is two hundred twenty-four to three hundred twenty person-hours, with a twenty percent contingency. The team will review transaction and queue changes together. To conclude, the proposed system combines capacity integrity, explainable queue decisions and accountable follow-up within a controlled outpatient scope. The following reference slides contain all thirty-two report references. Thank you; we are ready for your questions.

## References and close

After slide 21, show that the reference appendix is present and move to slide 33. If the panel wants to inspect sources, remain on the relevant reference slide. Never rush through eleven reference slides while reading authors and titles.

# Likely panel questions and prepared answers

These answers are rehearsal material, not extra claims. Keep the first answer to roughly 20–30 seconds. Expand only if the panel asks. The question numbering here is separate from slide numbering.

### 1. What does BEA contribute to this project?

BEA focuses on coordinating business processes, roles, data and deployment. The project demonstrates that through separate lifecycles, transactional consistency, authorization, durable jobs and four architectural views.

### 2. Is this an implemented system or a proposal?

This submission is a Phase 1 requirements and architecture proposal. Implementation, benchmark results and hospital validation remain Phase 2 work. We must not describe a planned metric as an achieved result.

### 3. Why not use a single patient token?

Patient identity, reservation, attendance, queue position and follow-up responsibility change independently. Separate linked records make missed appointments, walk-ins, skipped calls and future returns unambiguous.

### 4. What exactly is your queue algorithm?

After checking that the doctor is free and the session allows calls, select only eligible waiting entries. Consider authorized clinical priority first, then oldest eligible wait of at least 45 minutes, then the A,A,W normal rotation. Use stable tie-breakers and record the reason.

### 5. Why choose two appointments for every walk-in?

It is an initial configurable service-allocation policy. It prioritizes planned appointments while providing a recurring walk-in opportunity. We will compare it with FCFS and test different mixes; we do not claim the ratio is mathematically optimal.

### 6. Why are there ten appointment places and five walk-in places?

This is the approved session admission assumption. The queue rotation describes selection order, while the ten/five split limits admission. Empty groups and overrides mean the realized order need not remain exactly two to one.

### 7. Does aging guarantee service within 45 minutes?

No. Forty-five minutes triggers an aging override when no clinical-priority candidate exists. Continuing priority demand, long consultations or overload can still produce longer waits.

### 8. Who assigns clinical priority?

Only an authorized clinical actor, with an auditable reason. The assistant cannot assign it, and a follow-up escalation does not automatically become a clinical-priority queue entry.

### 9. Can a higher-priority patient interrupt a consultation?

No. The selected policy is non-preemptive. Clinical priority affects the next allocation after the doctor becomes free, not a consultation already in progress.

### 10. What are the tie-breakers?

Priority candidates use clinical class, eligible waiting time and stable sequence. Appointment candidates use scheduled time, check-in time and sequence. Walk-ins use accepted check-in time and sequence. Aging selects the oldest eligible wait with stable sequence as the tie-breaker.

### 11. What happens when one queue group is empty?

The normal rotation skips empty positions without accumulating unused credits. After a normal selection, the pointer advances past the position actually served. Priority and aging overrides preserve that pointer.

### 12. Why use a linear scan rather than a heap?

At the planned small session size, an O(n) scan is simple and sufficient. Eligibility, waiting time and priority can change, so a heap adds update complexity. We will measure before introducing a more complicated data structure.

### 13. How do you prevent two bookings for the last place?

All capacity-changing operations acquire the same capacity guard, recheck state and commit the allocation and appointment together. The next competing transaction observes the committed capacity and returns a controlled conflict.

### 14. Why does call-next need a doctor lock?

Two transactions can lock two different queue rows and still allocate two patients to one doctor. The doctor guard protects the shared allocation across sessions; the session guard protects queue-policy state.

### 15. Are locks held while the patient is being treated?

No. Database locks last only for the short state-change transaction. The persisted called or in-service allocation prevents a later command from allocating the occupied doctor.

### 16. What happens if a booking succeeds but the response is lost?

The client retries with the same idempotency identity. The backend checks actor, operation, key and input hash and returns the stored outcome. A reused key with different input is rejected.

### 17. What if a rescheduled appointment cannot be reserved?

The old and new reservation changes occur in one transaction using a consistent guard order. If target capacity is unavailable, the original reservation remains intact.

### 18. What happens when a patient is late or misses a call?

After the 15-minute arrival grace, reception must recheck capacity. If admitted, the late patient follows walk-in ordering. An unanswered call is skipped after two minutes; a return reuses the queue entry with fresh eligibility and retained history.

### 19. How is waiting time estimated?

An EWMA updates the duration estimate from completed consultations. The projection includes remaining active work, patients expected ahead under the same policy and known pauses. It advances simulated time for aging and eligibility and exposes uncertainty.

### 20. Why is alpha 0.2 and the initial duration 12 minutes?

They are explicit initial project parameters, not hospital measurements. Alpha controls how strongly the latest duration affects the average. We will evaluate calibration and error before changing these values or claiming accuracy.

### 21. Why is the ETA not simply queue length multiplied by average duration?

That ignores the residual active consultation, priority changes, future eligibility, aging and doctor pauses. Our projection models these known effects; unpredictable arrivals and priority changes remain uncertain.

### 22. How can 300 patients create 100 requests per second?

Visits and server requests measure different things. The synthetic model assumes 200 connected clients and interactive activity; 100 requests/s is a test headroom target with a specified endpoint mix. It is not inferred directly from daily visits.

### 23. Can the proposed server definitely handle that load?

No throughput capacity has been demonstrated yet. The proposed machine sizes are initial test configurations. Load tests must measure latency, errors, connection counts, database pool waits and lock contention under the declared workload.

### 24. Why a modular monolith instead of microservices?

The approved scale benefits from local transactions and fewer deployment dependencies. Code modules preserve responsibility boundaries. Service separation is a later decision if measured scaling or organizational needs justify its cost.

### 25. Why PostgreSQL instead of a document database?

Reservations, visits, doctors, allocations and tasks have explicit relationships and shared integrity rules. PostgreSQL supports foreign keys, uniqueness and short transactions. Document bytes still belong in object storage.

### 26. Why SSE instead of continuous polling or WebSockets?

Queue updates mainly flow from server to client, so SSE fits the requirement. It reduces repeated per-client polling but still consumes connections. Reconnection fetches a current snapshot. Bidirectional real-time transport is not currently required.

### 27. What makes the follow-up loop closed?

Each task has an owner, due time, state and recorded outcome. Unsupported questions become visible staff work. Closure records a disposition, and a required return creates a new capacity-checked appointment linked to the task.

### 28. What if OCR reads a prescription incorrectly?

OCR is a draft only. An authorized clinical reviewer corrects and verifies the instruction version before it can become assistant context. Low-quality, handwritten and failed extracts require separate evaluation and manual handling.

### 29. Is Tesseract the OCR product you are deploying?

No. Google Vision is the selected service. The Tesseract paper provides OCR background; it does not describe Vision internals or establish prescription accuracy.

### 30. Does using RAG remove hallucination or make the assistant medically safe?

No. Source grounding does not eliminate incorrect answers or establish clinical safety. The assistant is restricted to verified patient context, cites instruction versions and routes unsupported questions to staff. Clinical validation is separate.

### 31. What happens when Vision or the model is unavailable?

The add-on job records its status and uses bounded retries or staff handling. Provider work runs outside the booking transaction, so a provider failure should not block appointment or queue operations.

### 32. Does Mumbai hosting mean all data processing stays in India?

No. The preferred location covers application and database resources, subject to availability. OCR and model processing locations and provider terms must be verified independently.

### 33. Is the solution free to host?

No. Local demonstration controls cost, while hosted compute, database, storage, authentication and processing have separate cost drivers. Credits and free allowances cannot be assumed. The report contains dated API examples and an incomplete hosted cost worksheet.

### 34. What is the difference between RPO and RTO?

RPO concerns how much recent committed data can be lost at recovery; RTO concerns how long restoration takes. The targets are at most 15 and 60 minutes respectively, to be measured in a complete recovery exercise.

### 35. How will you demonstrate that the queue policy helps?

Compare it with FCFS using identical generated arrivals, durations and pauses across recorded seeds. Report median and p95 waits, group-specific waits, longest observed waits, completed visits and utilization, including metrics that get worse.

### 36. What is novel about the project?

We do not claim invention of appointments, OCR or follow-up assistants. The engineering contribution to evaluate is the integration of separate lifecycles, transactional queue integrity, explainable selection and accountable follow-up in one bounded system.

### 37. How should we answer a question we cannot verify?

State the boundary directly: that detail is not yet measured or decided. Explain the current design and the experiment or decision needed. Do not invent performance, a hospital observation or a paper result to satisfy the question.

# Vocabulary rehearsal in three levels

The reception-desk story below is only a private learning aid. Use the formal explanations in the main presentation.

## Transaction

Level 1 — reception story: The receptionist completes a whole booking entry, or leaves the book as it was.

Level 2 — developer explanation: A transaction groups database operations so they commit together or roll back together.

Level 3 — presentation vocabulary: Atomicity protects the reservation and capacity update as one unit; consistent locking coordinates concurrent writers.

## Idempotency

Level 1 — reception story: Pressing the booking button again brings back the same booking instead of adding another one.

Level 2 — developer explanation: An actor/operation/key record with an input hash and stored result identifies a repeated request.

Level 3 — presentation vocabulary: Idempotent command handling lets clients recover from an uncertain network response without repeating a committed domain effect.

## Aging

Level 1 — reception story: A child who has waited a long time gets attention before the normal appointment/walk-in turn is followed.

Level 2 — developer explanation: The scheduler checks eligible waiting duration against 45 minutes when no clinical-priority candidate exists.

Level 3 — presentation vocabulary: Aging reduces neglect under ordinary load, but it is not a finite waiting-time guarantee during overload or sustained higher-priority demand.

## Non-preemptive scheduling

Level 1 — reception story: The doctor finishes with the person already inside before calling another patient.

Level 2 — developer explanation: A priority update changes a future allocation, never the active in-service consultation.

Level 3 — presentation vocabulary: Non-preemption bounds scheduling decisions to service boundaries and preserves the approved consultation workflow.

## EWMA

Level 1 — reception story: The receptionist updates the usual consultation time using today’s latest visit without forgetting earlier visits.

Level 2 — developer explanation: The estimate is 0.2 times the latest duration plus 0.8 times the previous estimate.

Level 3 — presentation vocabulary: Exponential smoothing weights recent observations more heavily; queue-policy projection and residual-work handling are additional components of ETA.

## Closed-loop follow-up

Level 1 — reception story: The follow-up notebook records who must help and stays open until the result is written down.

Level 2 — developer explanation: A task has an owner, due time, state and recorded disposition; a return links to a new capacity-checked booking.

Level 3 — presentation vocabulary: Explicit ownership and closure conditions make unfinished work observable and provide traceability across otherwise separate encounter lifecycles.

## p95 latency

Level 1 — reception story: For every hundred measured requests, about ninety-five finish within the stated response-time value.

Level 2 — developer explanation: The 95th percentile summarizes the upper part of the observed latency distribution.

Level 3 — presentation vocabulary: A percentile target must be evaluated against a declared workload, measurement boundary and error policy; it does not describe every request.

## RPO and RTO

Level 1 — reception story: After the appointment book is damaged, one limit is how much recent writing can be missing, and another is how long reopening takes.

Level 2 — developer explanation: RPO is the recoverable data-loss window; RTO is elapsed time to restore usable service.

Level 3 — presentation vocabulary: Backup configuration supports the recovery point, while a complete restoration and reconciliation exercise establishes the observed recovery time.

# Backup slide guide

**Slide 34: Arrival and Exception Rules**

**Slide 35: Waiting-Time Estimation**

**Slide 36: Queue Policy Example**

**Slide 37: Privacy and Failure Handling**

**Slide 38: Recovery and Availability**

**Slide 39: Literature and Project Contribution**

## Answers that must remain precise

“Forty-five minutes” is the aging trigger, not a maximum waiting-time promise.

“One hundred requests per second” is a test target, not measured server capacity.

“Three hundred visits per day” and “twelve minutes per consultation” are synthetic planning assumptions.

“MediBridge-inspired” describes the add-on idea. The implementation and architecture are new.

“Verified context” limits what the assistant may use; it does not establish clinical safety.

“Mumbai preferred” does not establish that every external provider processes data in India.

“Research background” does not mean the cited studies prove our exact policy optimal.

“Task closed” means a recorded staff disposition, not that a message was merely sent.
