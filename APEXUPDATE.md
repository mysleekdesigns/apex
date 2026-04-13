# APEX Next-Generation Update Plan

## Making APEX the Most Advanced AI Agent Self-Learning System

**Current State:** ~51,100 LOC TypeScript | 1,012 tests | 35 MCP tools | 4-tier memory | 3-level reflection | HNSW vector index | hybrid retrieval | benchmark suite | Zod validation | atomic file ops | concurrency locks | transaction rollback | memory bounds | Reflexion templates | verbal rewards | quality tracking | MCTS planning | LM value functions | adaptive exploration | tree persistence | DSPy-inspired prompt optimization | A/B testing | prompt mutation engine | few-shot curation | regression detection | ACT-R activation | cognitive cycle | goal stack | production rules | self-benchmarking harness | self-modification pipeline | performance-gated deployment | auto-rollback | passive telemetry | episode detection | implicit rewards | session summarization | action-effect graph | causal chain extraction | counterfactual reasoning | predictive planning
**Target State:** ~47,000 LOC | ~1,100 tests | 39+ MCP tools | 12 new frontier capabilities

**Research Basis:** MemGPT/Letta, Reflexion, LATS (ICML 2024), DSPy, Darwin-Godel Machine, SOAR/ACT-R cognitive architectures, SWE-bench self-improving agents, NeurIPS/ICML 2024-2025 frontier work.

---

## Wave 1: Foundation (Enable Everything Else)

---

### Phase 11: Semantic Vector Memory (~800 LOC, ~40 tests) [HIGH IMPACT] ✅ COMPLETED

**Problem:** APEX uses TF-IDF + SimHash for similarity. "fix authentication bug" won't match "resolve login error." Letta benchmark (Aug 2025) showed hybrid retrieval scores 74% on LoCoMo, beating pure approaches.

**Research:** MemGPT (arxiv:2310.08560) | Letta benchmarks (Aug 2025) | ACT-R memory (ACM 2026)

**Completed:** 2026-04-12 | 458 tests passing | TypeScript clean

#### Core Infrastructure
- [x] Implement HNSW (Hierarchical Navigable Small World) index in `src/utils/vector-index.ts`
- [x] Support configurable distance metrics (cosine, euclidean, dot product)
- [x] Implement incremental insert and delete operations
- [x] Add serialization/deserialization for index persistence
- [x] Benchmark: sub-linear retrieval at 10K+ entries (<50ms)

#### Embedding Upgrade
- [x] Make `@huggingface/transformers` L2 embedding the default (was opt-in)
- [x] Default model: `all-MiniLM-L6-v2` (23MB, ~30ms per embed)
- [x] Add embedding cache with LRU eviction to avoid re-computation
- [x] Implement lazy model loading (only load on first embed call)
- [x] Fallback: graceful degradation to L0+L1 if model fails to load
- [x] Update `src/utils/embeddings.ts` with new defaults

#### Hybrid Retrieval
- [x] Implement BM25 scoring in `src/utils/similarity.ts`
- [x] Combine: vector similarity (0.6) + BM25 keyword (0.3) + recency (0.1)
- [x] Make weights configurable via architecture search
- [x] Add retrieval quality metrics (MRR, recall@k)

#### Embed-on-Write Pipeline
- [x] Modify `src/memory/manager.ts` to embed entries on write
- [x] Store embeddings alongside entries in file store
- [x] Background embedding queue for batch writes
- [x] Update `src/memory/episodic.ts` for vector-aware segment retrieval
- [x] Update `src/memory/semantic.ts` for vector-aware dedup and retrieval

#### Tests
- [x] Unit tests for HNSW index (insert, search, delete, persistence)
- [x] Unit tests for BM25 scoring
- [x] Integration tests for hybrid retrieval vs pure keyword vs pure vector
- [x] Benchmark tests: retrieval latency at 1K, 5K, 10K entries
- [x] Regression tests: existing retrieval behavior preserved as fallback

---

### Phase 21: Benchmarking & Evaluation Framework (~600 LOC, ~20 tests) [HIGH IMPACT] ✅ COMPLETED

**Problem:** No way to measure if APEX is actually helping. Letta benchmark showed rigorous evaluation is critical -- many systems that "feel" good perform poorly on standardized tasks.

**Research:** Letta LoCoMo benchmark (Aug 2025) | SWE-bench methodology | METR framework (2026)

**Completed:** 2026-04-12 | 512 tests passing | TypeScript clean

#### Recall Accuracy Benchmark
- [x] Create `src/benchmarks/locomo-adapt.ts` -- adapted LoCoMo for APEX
- [x] Seed memory with known episodes at various depths (10, 100, 500, 1000)
- [x] Test recall accuracy: exact match, semantic match, partial match
- [x] Measure recall@1, recall@5, recall@10, MRR
- [x] Track false positive rate (irrelevant results returned)

#### Skill Transfer Benchmark
- [x] Create `src/benchmarks/skill-transfer.ts`
- [x] Setup: learn skills in project A, measure applicability in project B
- [x] Measure: skill discovery rate, adaptation accuracy, confidence calibration
- [x] Test cross-language transfer (e.g., Node.js skill applied to Python project)

#### Reflection Quality Benchmark
- [x] Create `src/benchmarks/reflection-quality.ts`
- [x] Measure: does applying a reflection improve next-attempt success rate?
- [x] Track reflection actionability score (% of insights that are concrete)
- [x] Track reflection freshness (do old reflections still apply?)

#### Consolidation Loss Benchmark
- [x] Measure information loss during working -> episodic -> semantic promotion
- [x] Track: can promoted entries still answer original queries?
- [x] Measure merge quality (do merged semantic entries preserve key facts?)

#### Dashboard & CI Integration
- [x] Create `src/benchmarks/dashboard.ts` -- HTML report generator
- [x] Show learning curves, benchmark scores, memory health over time
- [x] Add benchmark CI gate in `vitest.config.ts`
- [x] Latency gates: recall <100ms at 10K entries, embedding <50ms

---

### Phase 22: Safety & Robustness Hardening (~4,024 LOC, ~202 tests) [MEDIUM IMPACT] ✅ COMPLETED

**Problem:** No input validation in handlers, silent file read failures, no transaction semantics for consolidation, no concurrency protection.

**Completed:** 2026-04-12 | 713 tests passing | TypeScript clean

#### Input Validation
- [x] Add `zod` dependency to `package.json`
- [x] Create Zod schemas for all 27 tool input types in `src/mcp/schemas.ts`
- [x] Add validation at handler entry points in `src/mcp/handlers.ts` via `validateArgs` helper
- [x] Return structured error messages for invalid inputs with field-level details
- [x] Test: fuzz all 27 handlers with malformed inputs (540 validation runs)

#### Atomic File Operations
- [x] Modify `src/utils/file-store.ts` for write-to-temp-then-rename pattern (unique nonce suffix)
- [x] Add JSON validation on read (detect corrupted files)
- [x] Auto-restore from latest snapshot on corruption detection
- [x] Add SHA-256 checksum verification for critical files (`.sha256` companion files)
- [x] Add `.bak` backup files before each overwrite

#### Concurrency Protection
- [x] Create `src/utils/file-lock.ts` -- in-process async mutex with FIFO queuing
- [x] Add lock acquisition/release around memory mutations in manager and file store
- [x] Implement lock timeout with deadlock detection and force-release
- [x] Test: concurrent read/write stress tests (10 concurrent writes, no corruption)

#### Transaction Semantics
- [x] Create `src/memory/transaction.ts` -- in-memory checkpoint with rollback
- [x] Wrap consolidation in `src/memory/manager.ts` with atomic transaction
- [x] If any step fails, rollback all changes via `structuredClone` checkpoint
- [x] Create `src/memory/audit-log.ts` -- append-only JSONL audit log with auto-rotation
- [x] Test: simulate mid-consolidation crash and verify recovery

#### Memory Bounds
- [x] Create `src/memory/bounds.ts` -- soft/hard limit enforcement with tier-specific eviction
- [x] Enforce hard limits with graceful degradation (evict lowest-value entries first)
- [x] Add memory usage monitoring (total file size, entry counts per tier) in `apex_status`
- [x] Alert when approaching 80% capacity with actionable messages
- [x] Test: exceed limits and verify graceful eviction across all tiers

---

## Wave 2: Core Intelligence Improvements

---

### Phase 12: Verbal Reinforcement Learning / Reflexion (~1,952 LOC, 29 tests) [HIGH IMPACT] ✅ COMPLETED

**Problem:** No structured verbal reinforcement loop. Reflexion (NeurIPS 2023, 5,342+ citations) achieved 91% HumanEval pass@1 (vs 80% baseline) purely from structured self-critique.

**Research:** Reflexion (arxiv:2303.11366) | Andrew Ng's agentic patterns (2024) | Bristol self-improving agent (arxiv:2504.15228)

**Completed:** 2026-04-12 | 742 tests passing | TypeScript clean

#### Structured Reflection Templates
- [x] Create Reflexion-style "actor-evaluator-self-reflection" templates in `src/reflection/micro.ts`
- [x] Template fields: what_happened, root_cause, what_to_try_next, confidence
- [x] Generate structured prompts that guide Claude's reflection process
- [x] Support both success reflections (what worked and why) and failure reflections

#### Verbal Reward Signals
- [x] Create `src/reflection/verbal-reward.ts` -- verbal RL signal generator
- [x] Convert episode outcomes into natural language reward signals
- [x] Store rewards as first-class memory entries in semantic tier
- [x] Format: "When doing X, approach Y failed because Z. Next time try W."
- [x] Auto-generate contrastive pairs (failed vs successful for same task type)

#### Reflection-Conditioned Planning
- [x] Modify `src/planning/context.ts` to inject relevant verbal reflections
- [x] When `apex_plan_context` called, include "lessons learned" constraints
- [x] Rank reflections by relevance to current task (using combined similarity)
- [x] Cap injected reflections to avoid context bloat (top 5 most relevant)

#### Reflection Quality Tracking
- [x] Create `src/reflection/quality-tracker.ts` to track reflection effectiveness
- [x] Did the agent succeed after applying this insight? Track correlation
- [x] Compute reflection quality score: (subsequent_success_rate - baseline)
- [x] Auto-prune reflections with quality score < 0.1 after 5+ applications
- [x] Promote high-quality reflections (score > 0.5) to semantic memory

#### Tests
- [x] Unit tests for verbal reward signal generation (8 tests)
- [x] Unit tests for structured reflection templates (6 tests)
- [x] Unit tests for reflection quality scoring (10 tests)
- [x] Unit tests for reflection injection into plan context (5 tests)

---

### Phase 13: Enhanced MCTS Planning with LM Value Functions (~2,478 LOC + 1,804 test LOC, 72 tests) [HIGH IMPACT] ✅ COMPLETED

**Problem:** APEX's action tree is purely retrospective. LATS (ICML 2024) showed MCTS + LM value functions achieves SOTA on programming, QA, web navigation, and math simultaneously.

**Research:** LATS (arxiv:2310.04406, ICML 2024) | Tree of Thoughts (Yao et al., 2023)

**Completed:** 2026-04-12 | 814 tests passing | TypeScript clean

**New modules:**
- `src/planning/mcts.ts` (671 LOC) — Full MCTS engine: UCB1 selection, expansion with thresholds, simulation via historical outcomes + optional LM value functions, backpropagation, FileStore persistence
- `src/planning/lm-value.ts` (570 LOC) — Structured prompt generation for Claude plan evaluation, Jaccard-based value cache with TTL/eviction, accuracy tracking (MAE, Pearson correlation, calibration buckets)
- `src/planning/adaptive-exploration.ts` (380 LOC) — Per-domain learned exploration constants replacing fixed sqrt(2), exploration decay, over/under-exploration detection, domain-tuned ValueEstimator factory
- `src/planning/tree-persistence.ts` (857 LOC) — Saves promising subtrees per task type, restores across sessions, advanced pruning (confidently bad branches), tree compaction (merge similar siblings), growth metrics tracking

#### Forward-Looking Tree Search
- [x] Create `src/planning/mcts.ts` -- full MCTS implementation
- [x] Extend `src/planning/action-tree.ts` for prospective candidate generation
- [x] Selection: UCB1 with adaptive exploration constant
- [x] Expansion: generate candidate action sequences from current state
- [x] Simulation: lightweight rollout using historical action-outcome patterns
- [x] Backpropagation: update node values with real episode outcomes

#### LM Value Function Interface
- [x] Design prompt templates for Claude to evaluate candidate plans (score 0-1)
- [x] Store LM evaluations as training signals over time
- [x] Implement value function cache (avoid re-evaluating similar plans)
- [x] Track LM value prediction accuracy vs actual outcomes

#### Adaptive Exploration
- [x] Replace fixed UCB1 `c=sqrt(2)` with learned constant per task domain
- [x] Track exploration-exploitation balance: are we over-exploring known domains?
- [x] Implement exploration decay: reduce exploration as confidence increases
- [x] Modify `src/planning/value.ts` for adaptive constants

#### Tree Persistence & Pruning
- [x] Persist promising subtrees across sessions for recurring task types
- [x] Auto-prune branches: avgValue < 0.2 AND visits > 5 (confidently bad)
- [x] Implement tree compaction: merge similar nodes to reduce memory
- [x] Track tree growth metrics (depth, breadth, pruning rate)

#### Tests
- [x] Unit tests for MCTS selection, expansion, simulation, backpropagation
- [x] Test adaptive exploration constant learning
- [x] Integration test: plan -> execute -> backpropagate -> improved plan
- [x] Test tree persistence across simulated sessions
- [x] Benchmark: planning quality vs baseline UCB1

---

### Phase 14: DSPy-Inspired Prompt Auto-Optimization (~2,573 LOC, 44 tests) [HIGH IMPACT] ✅ COMPLETED

**Problem:** CLAUDE.md instructions are static. DSPy (Stanford, 24K+ GitHub stars) showed algorithmically optimized prompts outperform hand-written ones by 20-40%.

**Research:** DSPy (Stanford NLP) | MIPROv2 | TextGrad

**Completed:** 2026-04-12 | 858 tests passing | TypeScript clean

**New modules:**
- `src/mcp/dynamic-descriptions.ts` (297 LOC) — PromptModuleRegistry: modular prompt units with versioning, A/B variants, effectiveness metrics, hot-swap support
- `src/integration/ab-testing.ts` (265 LOC) — ABTestManager: chi-squared significance testing, 50/50 variant assignment, auto-evaluation and conclusion
- `src/evolution/prompt-optimizer.ts` (424 LOC) — PromptOptimizer: 6 rule-based mutation strategies (rephrase, simplify, elaborate, adjust-emphasis, add/remove examples), heuristic impact estimation, PromptSuggestion-compatible output
- `src/evolution/few-shot-curator.ts` (258 LOC) — FewShotCurator: episode-based example extraction, quality ranking with rotation, usage/outcome tracking, pruning
- `src/evolution/regression-detector.ts` (330 LOC) — RegressionDetector: composite scoring, configurable warning/critical thresholds, linear regression trend detection, snapshot eviction, rollback recommendations

**New MCP tools:** `apex_prompt_optimize` (run optimization rounds, view status, conclude experiments), `apex_prompt_module` (register, list, get, hot-swap, add-variant, examples)

#### Modular Prompt System
- [x] Decompose CLAUDE.md into modular prompt "modules" (one per tool/behavior)
- [x] Create `src/mcp/dynamic-descriptions.ts` -- dynamic tool descriptions
- [x] Each module: instruction text + few-shot examples + effectiveness metrics
- [x] Support hot-swapping prompt modules without server restart

#### A/B Testing Framework
- [x] Extend `src/integration/effectiveness-tracker.ts` with A/B testing
- [x] Track which prompt variants lead to better: recall hit rate, reflection quality, skill reuse
- [x] Statistical significance testing (chi-squared) before declaring a winner
- [x] Automatic promotion of winning variants

#### Automated Prompt Mutation
- [x] Create `src/evolution/prompt-optimizer.ts` -- prompt mutation engine
- [x] Mutation types: add example, remove example, rephrase instruction, adjust emphasis
- [x] Based on effectiveness metrics, suggest and test modifications
- [x] `apex_arch_suggest` extended to include prompt optimization suggestions

#### Few-Shot Example Curation
- [x] Auto-select best few-shot examples from successful episodes
- [x] Inject curated examples into tool descriptions
- [x] Track which examples improve tool usage patterns
- [x] Rotate examples to avoid overfitting to specific patterns

#### Performance Regression Detection
- [x] Alert when a prompt change degrades performance vs baseline
- [x] Automatic rollback of prompt changes that degrade metrics
- [x] Track prompt performance over time (learning curve per module)

---

## Wave 3: Advanced Capabilities

---

### Phase 15: Cognitive Architecture Integration (~2,476 LOC, 46 tests) [MEDIUM IMPACT] ✅ COMPLETED

**Problem:** SOAR/ACT-R cognitive design patterns (UMich 2025) show structured cognitive loops improve agent consistency and learning speed. APEX has the components but lacks formal cognitive structure.

**Research:** SOAR (UMich, 2025) | ACT-R (ACM 2026) | LLM-ACTR (2024)

**Completed:** 2026-04-12 | 904 tests passing | TypeScript clean

**New modules:**
- `src/cognitive/activation.ts` (301 LOC) — ACT-R Base-Level Learning activation engine: `B_i = ln(sum(t_j^(-d)))`, spreading activation with configurable spread factor, sigmoid heat score conversion, effectiveness tracking with MRR comparison
- `src/cognitive/cycle.ts` (316 LOC) — Formal perceive→decide→act→learn cognitive loop: maps all 31 MCP tools to phases, cycle quality scoring, phase context injection, idle timeout detection
- `src/cognitive/goal-stack.ts` (303 LOC) — Persistent goal hierarchy: sub-goals with recursive progress, priority+deadline sorting, cascade abandon, keyword search, context string generation for planning
- `src/cognitive/production-rules.ts` (603 LOC) — If-then rule system: skill-to-rule extraction (confidence>0.8, usage>10), inverted-index O(1) pattern matching, accuracy tracking, auto-pruning of low-accuracy rules

**New MCP tools:** `apex_goals` (add, list, get, update, complete, block, abandon, search), `apex_cognitive_status` (phase, quality, activation stats, goal summary, rule stats)

#### ACT-R Activation-Based Memory
- [x] Replace heat scores in `src/memory/episodic.ts` with ACT-R Base-Level Learning
- [x] Formula: `B_i = ln(sum(t_j^(-d)))` where `t_j` = time since jth access, `d` = decay (~0.5)
- [x] Implement in `src/memory/semantic.ts` as well
- [x] Calibrate decay parameter against existing heat-based performance
- [x] Verify: activation-based retrieval >= heat-based retrieval on benchmarks

#### Spreading Activation
- [x] When a memory is recalled, boost activation of semantically related memories
- [x] Implement spreading activation network using embedding similarity
- [x] Configurable spread factor (default: 0.3 activation boost, 1-hop neighbors)
- [x] Track spreading activation effectiveness (did boosted memories get used?)

#### Formal Cognitive Cycle
- [x] Create `src/cognitive/cycle.ts` -- perceive -> decide -> act -> learn loop
- [x] Map MCP tools onto cognitive cycle phases
- [x] Track which phase the agent is in for better context assembly
- [x] Log cognitive cycle metrics (time per phase, phase transitions)

#### Goal Stack
- [x] Create `src/cognitive/goal-stack.ts` -- persistent goal hierarchy
- [x] Track multi-session objectives (e.g., "complete auth refactor")
- [x] Goals have: description, status, sub-goals, priority, deadline
- [x] Persist goal stack across sessions in `.apex-data/goals/`
- [x] Surface active goals in `apex_plan_context` responses

#### Production Rules
- [x] Create `src/cognitive/production-rules.ts` -- if-then rule system
- [x] Convert high-confidence skills (>0.8 confidence, >10 uses) into production rules
- [x] Production rules bypass embedding search (O(1) pattern matching)
- [x] Rule format: IF (condition pattern) THEN (action pattern) WITH (confidence)
- [x] Track rule hit rate and accuracy

#### Tests
- [x] Unit tests for ACT-R activation equation (11 tests)
- [x] Unit tests for spreading activation
- [x] Integration test: full cognitive cycle with goal tracking (10 tests)
- [x] Test production rule extraction from skills (14 tests)
- [x] Goal stack tests (11 tests)

---

### Phase 16: Self-Improving Agent Loop / Darwin-Godel Machine (~650 LOC, 30 tests) [HIGH IMPACT] ✅ COMPLETED

**Problem:** Darwin-Godel Machine (Sakana AI, 2025) showed coding agents can edit their own code and improve SWE-bench by 17-53%. APEX's evolution loop operates on virtual configs, not actual code.

**Research:** Darwin-Godel Machine (Sakana AI, 2025) | Bristol (arxiv:2504.15228) | Self-Play SWE-RL (arxiv:2512.18552)

**Completed:** 2026-04-12 | 947 tests passing | TypeScript clean

**New modules:**
- `src/evolution/self-benchmark.ts` (~310 LOC) — SelfBenchmark: 5-dimension benchmark suite (recall accuracy, reflection quality, skill reuse, planning effectiveness, consolidation efficiency), synthetic data seeding, benchmark comparison with degradation detection, generation tracking
- `src/evolution/self-modify.ts` (~340 LOC) — SelfModifier: weak spot analysis with targeted proposals, performance-gated deployment (≥5% improvement, no >2% degradation), auto-rollback detection (>10% degradation from best-ever), modification history tracking

**New MCP tools:** `apex_self_benchmark` (run, history, compare, seed), `apex_self_modify` (analyze, evaluate, history, rollback-check, stats)

#### Self-Benchmarking Harness
- [x] Create `src/evolution/self-benchmark.ts` -- standardized APEX benchmark suite
- [x] Benchmark dimensions: recall accuracy, reflection quality, skill reuse rate, planning effectiveness, consolidation efficiency
- [x] Seed benchmark with synthetic episodes covering diverse task types
- [x] Track benchmark scores over time (generations of self-improvement)

#### Automated Self-Modification Proposals
- [x] Create `src/evolution/self-modify.ts` -- safe self-modification pipeline
- [x] After benchmark run, analyze weak spots
- [x] Propose concrete config/parameter changes (not source code changes initially)
- [x] Store proposals as episodes with expected impact predictions

#### Sandbox Testing
- [x] Run proposed modifications in isolated test environment
- [x] Use existing snapshot system for pre-modification backup
- [x] Execute full benchmark suite against proposed changes
- [x] Compare: proposed vs baseline scores

#### Performance-Gated Deployment
- [x] Only apply modifications that improve composite benchmark score by >5%
- [x] Require no individual benchmark dimension to degrade by >2%
- [x] Track modification history (what was changed, when, impact)
- [x] Support manual override for user-approved changes

#### Rollback Safety
- [x] Extend `src/memory/snapshots.ts` for automatic rollback on degradation
- [x] If performance degrades after N episodes, auto-rollback to last known good
- [x] Alert user of rollback with explanation
- [x] Learning curve visualization: track APEX performance over self-modification generations

#### Tests
- [x] Unit tests for benchmark harness (15 tests)
- [x] Test self-modification proposal generation (5 tests)
- [x] Test performance-gated deployment (accept and reject cases) (4 tests)
- [x] Test automatic rollback on degradation (3 tests)
- [x] Integration test: full self-improvement cycle (3 tests)

---

### Phase 20: Real-Time Learning Signals (~730 LOC, 30 tests) [MEDIUM IMPACT] ✅ COMPLETED

**Problem:** APEX only learns from explicit `apex_record` calls. Much learning signal is lost -- which files were read, which commands succeeded/failed, how long things took.

**Completed:** 2026-04-12 | 979 tests passing | TypeScript clean

**New modules:**
- `src/integration/telemetry.ts` (~270 LOC) — TelemetryCollector: ring buffer (100 events), tool call sequence tracking, timing/success recording, arg sanitization, per-tool stats aggregation, peak call rate computation, session summaries
- `src/integration/episode-detector.ts` (~180 LOC) — EpisodeDetector: 5 built-in detection rules (recall-plan-execute, record-reflect, recall-record, skill-search-store, setup-recall), sliding window pattern matching with wildcards and prefix matchers, non-overlapping deduplication, task/success inference
- `src/integration/implicit-rewards.ts` (~280 LOC) — ImplicitRewardEngine: 7 signal rules (recall-record cycles, tool failures, skill interactions, reflections, consolidation, repeated failures, slow execution), composite reward computation [-1,1], session-level aggregation

**New MCP tools:** `apex_telemetry` (summary, events, episodes, rewards, flush)

#### Passive Telemetry
- [x] Create `src/integration/telemetry.ts` -- tool call pattern tracking
- [x] Track MCP tool call sequences (which tools called in order, timing, success)
- [x] No manual recording required -- purely observational
- [x] Store telemetry in lightweight ring buffer (last 100 tool calls)

#### Automatic Episode Detection
- [x] Create `src/integration/episode-detector.ts` -- natural task boundary detection
- [x] Detect patterns: recall -> plan -> edit* -> test = one episode
- [x] Configurable detection rules (regex-like patterns over tool call sequences)
- [x] Auto-create episode records from detected boundaries

#### Implicit Reward Signals
- [x] Create `src/integration/implicit-rewards.ts` -- derive rewards from outcomes
- [x] Signal: test pass after code change = positive reward
- [x] Signal: user asks for revision = negative reward
- [x] Signal: skill reused successfully = positive reward for skill
- [x] Aggregate implicit signals into episode reward scores

#### Session Summarization
- [x] At session end, auto-summarize key outcomes
- [x] Store summary in episodic memory (with user opt-in flag)
- [x] Include: tools used, outcomes, time spent, errors encountered

#### Streaming Consolidation
- [x] Modify `src/memory/manager.ts` for continuous background consolidation
- [x] Trigger consolidation on threshold (e.g., every 10 new episodes)
- [x] Non-blocking: don't interrupt tool calls for consolidation
- [x] Track consolidation latency and frequency

---

## Wave 4: Ecosystem & Polish

---

### Phase 17: World Model / Causal Reasoning (~930 LOC, 31 tests) [MEDIUM IMPACT] ✅ COMPLETED

**Problem:** Planning is based on statistical patterns. A world model predicts action consequences -- moving from "what worked before" to "what should work given causal understanding."

**Research:** NeurIPS 2025 LAW Workshop | V-JEPA 2 (Meta, 2025) | Frontiers in AI (2026)

**Completed:** 2026-04-12 | 1,012 tests passing | TypeScript clean

**New modules:**
- `src/planning/world-model.ts` (~660 LOC) — WorldModel: directed action-effect graph with Bayesian edge weight updating, causal chain extraction via DFS, plan prediction with risk assessment, keyword-based chain search, FileStore persistence
- `src/planning/counterfactual.ts` (~270 LOC) — CounterfactualEngine: "what if" scenario analysis, alternative action suggestions, strategy comparison with improvement metrics

**New MCP tools:** `apex_world_model` (build, predict, chains, counterfactual, compare, stats)

#### Action-Effect Graph
- [x] Create `src/planning/world-model.ts` -- directed graph of action -> effect relationships
- [x] Build graph from successful episodes (e.g., "run tests" -> "discover bugs")
- [x] Track edge weights (probability of effect given action)
- [x] Bayesian updating: adjust probabilities after each new episode

#### Causal Chain Extraction
- [x] Extract causal chains from episode sequences (A enabled B which caused C)
- [x] Detect common causal patterns across episodes
- [x] Store causal chains as first-class knowledge in semantic memory
- [x] Surface relevant causal chains in `apex_plan_context`

#### Counterfactual Reasoning
- [x] Create `src/planning/counterfactual.ts` -- "what if" simulation
- [x] Use action-effect graph to simulate alternative action paths
- [x] "If I had done X instead of Y, what would have happened?"
- [x] Score counterfactual plans against actual outcomes

#### Predictive Planning
- [x] Before executing a plan, trace it through the world model
- [x] Predict likely outcomes and failure points for each step
- [x] Flag high-risk steps (low probability of success per world model)
- [x] Integrate with foresight engine in `src/reflection/foresight.ts`

#### Tests
- [x] Unit tests for action-effect graph (build, query, update) — 19 tests
- [x] Unit tests for causal chain extraction
- [x] Test counterfactual reasoning with known episode sequences — 12 tests
- [x] Integration test: world-model-informed planning vs baseline planning

---

### Phase 18: Advanced Multi-Agent Knowledge Sharing (~800 LOC, ~50 tests) [MEDIUM IMPACT]

**Problem:** No mechanism for real-world team knowledge sharing. Multiple developers on the same project can't learn from each other's APEX instances.

**Research:** Federated learning | CrewAI/AutoGen patterns | Git-based knowledge management

#### Team Knowledge Tier
- [ ] Create `src/team/knowledge-tier.ts` -- `.apex-shared/` directory management
- [ ] Git-tracked shared knowledge store
- [ ] Tier structure: `skills/`, `knowledge/`, `error-taxonomy/`, `proposals/`
- [ ] Privacy boundary: never share raw episodes, only distilled knowledge

#### Proposal-Review Workflow
- [ ] Create `src/team/proposal.ts` -- propose/review/approve workflow
- [ ] `apex_team_propose`: create skill/knowledge proposal (like a PR)
- [ ] `apex_team_review`: review pending proposals with accept/reject
- [ ] `apex_team_status`: show team learning stats and pending proposals
- [ ] `apex_team_sync`: ingest new `.apex-shared/` content
- [ ] `apex_team_log`: team learning changelog

#### MCP Tool Registration
- [ ] Add 5 team tools to `src/mcp/tools.ts`
- [ ] Implement handlers in `src/mcp/handlers.ts`
- [ ] Input validation with Zod schemas

#### Conflict Resolution
- [ ] When team knowledge conflicts with personal knowledge, present both
- [ ] Include provenance (who proposed, when, from which project)
- [ ] Configurable precedence: team > personal or personal > team

#### Federated Learning (Lite)
- [ ] Create `src/team/federation.ts` -- privacy-preserving aggregation
- [ ] Aggregate learning patterns without sharing raw data
- [ ] Metrics: team-wide success rates, common error patterns, skill usage
- [ ] Team skill leaderboard (which members' skills get most usage)

#### Tests
- [ ] Unit tests for knowledge tier CRUD operations
- [ ] Unit tests for proposal workflow (create, review, accept, reject)
- [ ] Integration test: propose skill -> review -> accept -> sync
- [ ] Test conflict resolution with competing knowledge entries
- [ ] Test privacy boundary (ensure episodes never leak to shared tier)

---

### Phase 19: Adaptive Embedding & Query Understanding (~400 LOC, ~25 tests) [MEDIUM IMPACT]

**Problem:** All queries treated uniformly. Error lookups should match differently than pattern searches. System should understand query intent.

#### Query Classification
- [ ] Create `src/memory/query-classifier.ts` -- intent classification
- [ ] Categories: error-lookup, pattern-search, skill-search, planning, exploratory
- [ ] Classification via keyword patterns + query structure analysis
- [ ] Track classification accuracy over time

#### Adaptive Retrieval Strategy
- [ ] Error lookups: prioritize exact match + error taxonomy
- [ ] Pattern searches: prioritize semantic similarity
- [ ] Skill searches: prioritize procedural memory
- [ ] Planning queries: prioritize action tree + episodic memory
- [ ] Modify `src/memory/manager.ts` for adaptive routing

#### Query Expansion
- [ ] Create `src/memory/query-expander.ts` -- automatic query expansion
- [ ] For vague queries, expand using related terms from semantic memory
- [ ] Example: "auth bug" -> "authentication error, login failure, session token"
- [ ] Limit expansion to top 3-5 related terms (avoid dilution)

#### Relevance Feedback Loop
- [ ] Track which recalled results the agent actually used
- [ ] "Used" = followed by apex_record referencing the recalled content
- [ ] Update retrieval ranking based on usage patterns
- [ ] Modify `src/integration/effectiveness-tracker.ts` for feedback tracking

#### Multi-Hop Retrieval
- [ ] For complex queries, perform iterative retrieval
- [ ] First recall gives context for refined second recall
- [ ] Cap at 2 hops to avoid latency explosion
- [ ] Track multi-hop improvement (did 2nd hop find better results?)

---

## Summary

| Wave | Phase | Description | LOC | Tests | Impact | Status |
|------|-------|-------------|-----|-------|--------|--------|
| 1 | 11 | Semantic Vector Memory | ~800 | 89 | HIGH | ✅ DONE |
| 1 | 21 | Benchmarking Framework | ~3,276 | 54 | HIGH | ✅ DONE |
| 1 | 22 | Safety Hardening | ~4,024 | 202 | MEDIUM | ✅ DONE |
| 2 | 12 | Verbal Reinforcement Learning | ~1,952 | 29 | HIGH | ✅ DONE |
| 2 | 13 | Enhanced MCTS Planning | ~2,478 | 72 | HIGH | ✅ DONE |
| 2 | 14 | Prompt Auto-Optimization | ~2,573 | 44 | HIGH | ✅ DONE |
| 3 | 15 | Cognitive Architecture | ~2,476 | 46 | MEDIUM | ✅ DONE |
| 3 | 16 | Self-Improving Agent Loop | ~650 | 30 | HIGH | ✅ DONE |
| 3 | 20 | Real-Time Learning Signals | ~730 | 30 | MEDIUM | ✅ DONE |
| 4 | 17 | World Model / Causal Reasoning | ~930 | 31 | MEDIUM | ✅ DONE |
| 4 | 18 | Team Knowledge Sharing | ~800 | ~50 | MEDIUM | |
| 4 | 19 | Adaptive Query Understanding | ~400 | ~25 | MEDIUM | |
| | | **Completed** | **~19,889** | **627** | | **10/12** |
| | | **Remaining** | **~1,200** | **~75** | | **2/12** |

## Key Research References

| System | Source | Key Innovation |
|--------|--------|----------------|
| MemGPT/Letta | arxiv:2310.08560 | OS-inspired memory hierarchy + vector retrieval |
| Reflexion | arxiv:2303.11366 | Verbal reinforcement learning (91% HumanEval) |
| LATS | arxiv:2310.04406 (ICML 2024) | MCTS + LM value functions |
| Voyager | MineDojo (2023) | Lifelong skill library + automatic curriculum |
| DSPy | Stanford NLP (24K+ stars) | Algorithmic prompt optimization (20-40% improvement) |
| Darwin-Godel Machine | Sakana AI (2025) | Self-modifying agent code (17-53% SWE-bench improvement) |
| ACT-R + LLM | ACM HAI 2026 | Psychologically grounded memory activation |
| SOAR + LLM | UMich (2025) | Cognitive design patterns for agents |
| Self-Play SWE-RL | arxiv:2512.18552 | Self-play training for coding agents |
| Live-SWE-Agent | arxiv:2511.13646 | Self-evolving software engineering agents |
| Letta Benchmark | letta.com (Aug 2025) | Rigorous agent memory evaluation (LoCoMo) |

## Verification Strategy

**Per Phase:**
1. Unit tests with >90% coverage on new modules
2. Integration tests: end-to-end workflow (record -> learn -> recall -> improve)
3. Benchmark comparison: before/after metrics
4. Regression: all existing 904 tests must pass
5. Performance: recall <100ms at 10K entries, embedding <50ms

**Per Wave:**
1. Run full benchmark suite
2. Manual testing with real Claude Code sessions
3. Track learning curves across multi-day test project
4. Performance profiling and optimization pass
