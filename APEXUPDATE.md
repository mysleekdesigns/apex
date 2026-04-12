# APEX Next-Generation Update Plan

## Making APEX the Most Advanced AI Agent Self-Learning System

**Current State:** ~33,600 LOC TypeScript | 512 tests | 27 MCP tools | 4-tier memory | 3-level reflection | HNSW vector index | hybrid retrieval | benchmark suite
**Target State:** ~36,400 LOC | ~764 tests | 39+ MCP tools | 12 new frontier capabilities

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

### Phase 22: Safety & Robustness Hardening (~400 LOC, ~40 tests) [MEDIUM IMPACT]

**Problem:** No input validation in handlers, silent file read failures, no transaction semantics for consolidation, no concurrency protection.

#### Input Validation
- [ ] Add `zod` dependency to `package.json`
- [ ] Create Zod schemas for all 27 tool input types
- [ ] Add validation at handler entry points in `src/mcp/handlers.ts`
- [ ] Return structured error messages for invalid inputs
- [ ] Test: fuzz all handlers with malformed inputs

#### Atomic File Operations
- [ ] Modify `src/utils/file-store.ts` for write-to-temp-then-rename pattern
- [ ] Add JSON validation on read (detect corrupted files)
- [ ] Auto-restore from latest snapshot on corruption detection
- [ ] Add checksum verification for critical files

#### Concurrency Protection
- [ ] Create `src/utils/file-lock.ts` -- file-level advisory locking
- [ ] Add lock acquisition/release around memory mutations in manager
- [ ] Implement lock timeout with deadlock detection
- [ ] Test: concurrent read/write stress test

#### Transaction Semantics
- [ ] Wrap consolidation in `src/memory/manager.ts` with atomic transaction
- [ ] If any step fails, rollback all changes (use pre-consolidation snapshot)
- [ ] Add audit log for all memory mutations
- [ ] Test: simulate mid-consolidation crash and verify recovery

#### Memory Bounds
- [ ] Enforce hard limits with graceful degradation (not just configurable defaults)
- [ ] Add memory usage monitoring (total file size, entry counts per tier)
- [ ] Alert when approaching 80% capacity
- [ ] Test: exceed limits and verify graceful eviction

---

## Wave 2: Core Intelligence Improvements

---

### Phase 12: Verbal Reinforcement Learning / Reflexion (~500 LOC, ~30 tests) [HIGH IMPACT]

**Problem:** No structured verbal reinforcement loop. Reflexion (NeurIPS 2023, 5,342+ citations) achieved 91% HumanEval pass@1 (vs 80% baseline) purely from structured self-critique.

**Research:** Reflexion (arxiv:2303.11366) | Andrew Ng's agentic patterns (2024) | Bristol self-improving agent (arxiv:2504.15228)

#### Structured Reflection Templates
- [ ] Create Reflexion-style "actor-evaluator-self-reflection" templates in `src/reflection/micro.ts`
- [ ] Template fields: what_went_wrong, root_cause, what_to_try_next, confidence
- [ ] Generate structured prompts that guide Claude's reflection process
- [ ] Support both success reflections (what worked and why) and failure reflections

#### Verbal Reward Signals
- [ ] Create `src/reflection/verbal-reward.ts` -- verbal RL signal generator
- [ ] Convert episode outcomes into natural language reward signals
- [ ] Store rewards as first-class memory entries in semantic tier
- [ ] Format: "When doing X, approach Y failed because Z. Next time try W."
- [ ] Auto-generate contrastive pairs (failed vs successful for same task type)

#### Reflection-Conditioned Planning
- [ ] Modify `src/planning/context.ts` to inject relevant verbal reflections
- [ ] When `apex_plan_context` called, include "lessons learned" constraints
- [ ] Rank reflections by relevance to current task (using vector similarity)
- [ ] Cap injected reflections to avoid context bloat (top 3-5 most relevant)

#### Reflection Quality Tracking
- [ ] Modify `src/reflection/coordinator.ts` to track reflection effectiveness
- [ ] Did the agent succeed after applying this insight? Track correlation
- [ ] Compute reflection quality score: (subsequent_success_rate - baseline)
- [ ] Auto-prune reflections with quality score < 0.1 after 5+ applications
- [ ] Promote high-quality reflections (score > 0.5) to semantic memory

#### Tests
- [ ] Unit tests for verbal reward signal generation
- [ ] Unit tests for structured reflection templates
- [ ] Integration test: record failure -> reflect -> record success on same task
- [ ] Test reflection quality scoring with synthetic episode sequences
- [ ] Test reflection injection into plan context

---

### Phase 13: Enhanced MCTS Planning with LM Value Functions (~600 LOC, ~35 tests) [HIGH IMPACT]

**Problem:** APEX's action tree is purely retrospective. LATS (ICML 2024) showed MCTS + LM value functions achieves SOTA on programming, QA, web navigation, and math simultaneously.

**Research:** LATS (arxiv:2310.04406, ICML 2024) | Tree of Thoughts (Yao et al., 2023)

#### Forward-Looking Tree Search
- [ ] Create `src/planning/mcts.ts` -- full MCTS implementation
- [ ] Extend `src/planning/action-tree.ts` for prospective candidate generation
- [ ] Selection: UCB1 with adaptive exploration constant
- [ ] Expansion: generate candidate action sequences from current state
- [ ] Simulation: lightweight rollout using historical action-outcome patterns
- [ ] Backpropagation: update node values with real episode outcomes

#### LM Value Function Interface
- [ ] Design prompt templates for Claude to evaluate candidate plans (score 0-1)
- [ ] Store LM evaluations as training signals over time
- [ ] Implement value function cache (avoid re-evaluating similar plans)
- [ ] Track LM value prediction accuracy vs actual outcomes

#### Adaptive Exploration
- [ ] Replace fixed UCB1 `c=sqrt(2)` with learned constant per task domain
- [ ] Track exploration-exploitation balance: are we over-exploring known domains?
- [ ] Implement exploration decay: reduce exploration as confidence increases
- [ ] Modify `src/planning/value.ts` for adaptive constants

#### Tree Persistence & Pruning
- [ ] Persist promising subtrees across sessions for recurring task types
- [ ] Auto-prune branches: avgValue < 0.2 AND visits > 5 (confidently bad)
- [ ] Implement tree compaction: merge similar nodes to reduce memory
- [ ] Track tree growth metrics (depth, breadth, pruning rate)

#### Tests
- [ ] Unit tests for MCTS selection, expansion, simulation, backpropagation
- [ ] Test adaptive exploration constant learning
- [ ] Integration test: plan -> execute -> backpropagate -> improved plan
- [ ] Test tree persistence across simulated sessions
- [ ] Benchmark: planning quality vs baseline UCB1

---

### Phase 14: DSPy-Inspired Prompt Auto-Optimization (~500 LOC, ~25 tests) [HIGH IMPACT]

**Problem:** CLAUDE.md instructions are static. DSPy (Stanford, 24K+ GitHub stars) showed algorithmically optimized prompts outperform hand-written ones by 20-40%.

**Research:** DSPy (Stanford NLP) | MIPROv2 | TextGrad

#### Modular Prompt System
- [ ] Decompose CLAUDE.md into modular prompt "modules" (one per tool/behavior)
- [ ] Create `src/mcp/dynamic-descriptions.ts` -- dynamic tool descriptions
- [ ] Each module: instruction text + few-shot examples + effectiveness metrics
- [ ] Support hot-swapping prompt modules without server restart

#### A/B Testing Framework
- [ ] Extend `src/integration/effectiveness-tracker.ts` with A/B testing
- [ ] Track which prompt variants lead to better: recall hit rate, reflection quality, skill reuse
- [ ] Statistical significance testing (chi-squared) before declaring a winner
- [ ] Automatic promotion of winning variants

#### Automated Prompt Mutation
- [ ] Create `src/evolution/prompt-optimizer.ts` -- prompt mutation engine
- [ ] Mutation types: add example, remove example, rephrase instruction, adjust emphasis
- [ ] Based on effectiveness metrics, suggest and test modifications
- [ ] `apex_arch_suggest` extended to include prompt optimization suggestions

#### Few-Shot Example Curation
- [ ] Auto-select best few-shot examples from successful episodes
- [ ] Inject curated examples into tool descriptions
- [ ] Track which examples improve tool usage patterns
- [ ] Rotate examples to avoid overfitting to specific patterns

#### Performance Regression Detection
- [ ] Alert when a prompt change degrades performance vs baseline
- [ ] Automatic rollback of prompt changes that degrade metrics
- [ ] Track prompt performance over time (learning curve per module)

---

## Wave 3: Advanced Capabilities

---

### Phase 15: Cognitive Architecture Integration (~700 LOC, ~40 tests) [MEDIUM IMPACT]

**Problem:** SOAR/ACT-R cognitive design patterns (UMich 2025) show structured cognitive loops improve agent consistency and learning speed. APEX has the components but lacks formal cognitive structure.

**Research:** SOAR (UMich, 2025) | ACT-R (ACM 2026) | LLM-ACTR (2024)

#### ACT-R Activation-Based Memory
- [ ] Replace heat scores in `src/memory/episodic.ts` with ACT-R Base-Level Learning
- [ ] Formula: `B_i = ln(sum(t_j^(-d)))` where `t_j` = time since jth access, `d` = decay (~0.5)
- [ ] Implement in `src/memory/semantic.ts` as well
- [ ] Calibrate decay parameter against existing heat-based performance
- [ ] Verify: activation-based retrieval >= heat-based retrieval on benchmarks

#### Spreading Activation
- [ ] When a memory is recalled, boost activation of semantically related memories
- [ ] Implement spreading activation network using embedding similarity
- [ ] Configurable spread factor (default: 0.3 activation boost, 1-hop neighbors)
- [ ] Track spreading activation effectiveness (did boosted memories get used?)

#### Formal Cognitive Cycle
- [ ] Create `src/cognitive/cycle.ts` -- perceive -> decide -> act -> learn loop
- [ ] Map MCP tools onto cognitive cycle phases
- [ ] Track which phase the agent is in for better context assembly
- [ ] Log cognitive cycle metrics (time per phase, phase transitions)

#### Goal Stack
- [ ] Create `src/cognitive/goal-stack.ts` -- persistent goal hierarchy
- [ ] Track multi-session objectives (e.g., "complete auth refactor")
- [ ] Goals have: description, status, sub-goals, priority, deadline
- [ ] Persist goal stack across sessions in `.apex-data/goals/`
- [ ] Surface active goals in `apex_plan_context` responses

#### Production Rules
- [ ] Create `src/cognitive/production-rules.ts` -- if-then rule system
- [ ] Convert high-confidence skills (>0.8 confidence, >10 uses) into production rules
- [ ] Production rules bypass embedding search (O(1) pattern matching)
- [ ] Rule format: IF (condition pattern) THEN (action pattern) WITH (confidence)
- [ ] Track rule hit rate and accuracy

#### Tests
- [ ] Unit tests for ACT-R activation equation
- [ ] Unit tests for spreading activation
- [ ] Integration test: full cognitive cycle with goal tracking
- [ ] Test production rule extraction from skills
- [ ] Benchmark: cognitive architecture vs baseline on recall quality

---

### Phase 16: Self-Improving Agent Loop / Darwin-Godel Machine (~600 LOC, ~30 tests) [HIGH IMPACT]

**Problem:** Darwin-Godel Machine (Sakana AI, 2025) showed coding agents can edit their own code and improve SWE-bench by 17-53%. APEX's evolution loop operates on virtual configs, not actual code.

**Research:** Darwin-Godel Machine (Sakana AI, 2025) | Bristol (arxiv:2504.15228) | Self-Play SWE-RL (arxiv:2512.18552)

#### Self-Benchmarking Harness
- [ ] Create `src/evolution/self-benchmark.ts` -- standardized APEX benchmark suite
- [ ] Benchmark dimensions: recall accuracy, reflection quality, skill reuse rate, planning effectiveness, consolidation efficiency
- [ ] Seed benchmark with synthetic episodes covering diverse task types
- [ ] Track benchmark scores over time (generations of self-improvement)

#### Automated Self-Modification Proposals
- [ ] Create `src/evolution/self-modify.ts` -- safe self-modification pipeline
- [ ] After benchmark run, analyze weak spots
- [ ] Propose concrete config/parameter changes (not source code changes initially)
- [ ] Store proposals as episodes with expected impact predictions

#### Sandbox Testing
- [ ] Run proposed modifications in isolated test environment
- [ ] Use existing snapshot system for pre-modification backup
- [ ] Execute full benchmark suite against proposed changes
- [ ] Compare: proposed vs baseline scores

#### Performance-Gated Deployment
- [ ] Only apply modifications that improve composite benchmark score by >5%
- [ ] Require no individual benchmark dimension to degrade by >2%
- [ ] Track modification history (what was changed, when, impact)
- [ ] Support manual override for user-approved changes

#### Rollback Safety
- [ ] Extend `src/memory/snapshots.ts` for automatic rollback on degradation
- [ ] If performance degrades after N episodes, auto-rollback to last known good
- [ ] Alert user of rollback with explanation
- [ ] Learning curve visualization: track APEX performance over self-modification generations

#### Tests
- [ ] Unit tests for benchmark harness
- [ ] Test self-modification proposal generation
- [ ] Test performance-gated deployment (accept and reject cases)
- [ ] Test automatic rollback on degradation
- [ ] Integration test: full self-improvement cycle

---

### Phase 20: Real-Time Learning Signals (~500 LOC, ~30 tests) [MEDIUM IMPACT]

**Problem:** APEX only learns from explicit `apex_record` calls. Much learning signal is lost -- which files were read, which commands succeeded/failed, how long things took.

#### Passive Telemetry
- [ ] Create `src/integration/telemetry.ts` -- tool call pattern tracking
- [ ] Track MCP tool call sequences (which tools called in order, timing, success)
- [ ] No manual recording required -- purely observational
- [ ] Store telemetry in lightweight ring buffer (last 100 tool calls)

#### Automatic Episode Detection
- [ ] Create `src/integration/episode-detector.ts` -- natural task boundary detection
- [ ] Detect patterns: recall -> plan -> edit* -> test = one episode
- [ ] Configurable detection rules (regex-like patterns over tool call sequences)
- [ ] Auto-create episode records from detected boundaries

#### Implicit Reward Signals
- [ ] Create `src/integration/implicit-rewards.ts` -- derive rewards from outcomes
- [ ] Signal: test pass after code change = positive reward
- [ ] Signal: user asks for revision = negative reward
- [ ] Signal: skill reused successfully = positive reward for skill
- [ ] Aggregate implicit signals into episode reward scores

#### Session Summarization
- [ ] At session end, auto-summarize key outcomes
- [ ] Store summary in episodic memory (with user opt-in flag)
- [ ] Include: tools used, outcomes, time spent, errors encountered

#### Streaming Consolidation
- [ ] Modify `src/memory/manager.ts` for continuous background consolidation
- [ ] Trigger consolidation on threshold (e.g., every 10 new episodes)
- [ ] Non-blocking: don't interrupt tool calls for consolidation
- [ ] Track consolidation latency and frequency

---

## Wave 4: Ecosystem & Polish

---

### Phase 17: World Model / Causal Reasoning (~500 LOC, ~30 tests) [MEDIUM IMPACT]

**Problem:** Planning is based on statistical patterns. A world model predicts action consequences -- moving from "what worked before" to "what should work given causal understanding."

**Research:** NeurIPS 2025 LAW Workshop | V-JEPA 2 (Meta, 2025) | Frontiers in AI (2026)

#### Action-Effect Graph
- [ ] Create `src/planning/world-model.ts` -- directed graph of action -> effect relationships
- [ ] Build graph from successful episodes (e.g., "run tests" -> "discover bugs")
- [ ] Track edge weights (probability of effect given action)
- [ ] Bayesian updating: adjust probabilities after each new episode

#### Causal Chain Extraction
- [ ] Extract causal chains from episode sequences (A enabled B which caused C)
- [ ] Detect common causal patterns across episodes
- [ ] Store causal chains as first-class knowledge in semantic memory
- [ ] Surface relevant causal chains in `apex_plan_context`

#### Counterfactual Reasoning
- [ ] Create `src/planning/counterfactual.ts` -- "what if" simulation
- [ ] Use action-effect graph to simulate alternative action paths
- [ ] "If I had done X instead of Y, what would have happened?"
- [ ] Score counterfactual plans against actual outcomes

#### Predictive Planning
- [ ] Before executing a plan, trace it through the world model
- [ ] Predict likely outcomes and failure points for each step
- [ ] Flag high-risk steps (low probability of success per world model)
- [ ] Integrate with foresight engine in `src/reflection/foresight.ts`

#### Tests
- [ ] Unit tests for action-effect graph (build, query, update)
- [ ] Unit tests for causal chain extraction
- [ ] Test counterfactual reasoning with known episode sequences
- [ ] Integration test: world-model-informed planning vs baseline planning

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

| Wave | Phase | Description | LOC | Tests | Impact |
|------|-------|-------------|-----|-------|--------|
| 1 | 11 | Semantic Vector Memory | ~800 | 89 | HIGH | ✅ DONE |
| 1 | 21 | Benchmarking Framework | ~3,276 | 54 | HIGH | ✅ DONE |
| 1 | 22 | Safety Hardening | ~400 | ~40 | MEDIUM |
| 2 | 12 | Verbal Reinforcement Learning | ~500 | ~30 | HIGH |
| 2 | 13 | Enhanced MCTS Planning | ~600 | ~35 | HIGH |
| 2 | 14 | Prompt Auto-Optimization | ~500 | ~25 | HIGH |
| 3 | 15 | Cognitive Architecture | ~700 | ~40 | MEDIUM |
| 3 | 16 | Self-Improving Agent Loop | ~600 | ~30 | HIGH |
| 3 | 20 | Real-Time Learning Signals | ~500 | ~30 | MEDIUM |
| 4 | 17 | World Model / Causal Reasoning | ~500 | ~30 | MEDIUM |
| 4 | 18 | Team Knowledge Sharing | ~800 | ~50 | MEDIUM |
| 4 | 19 | Adaptive Query Understanding | ~400 | ~25 | MEDIUM |
| | | **TOTAL** | **~6,900** | **~395** | |

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
4. Regression: all existing 369 tests must pass
5. Performance: recall <100ms at 10K entries, embedding <50ms

**Per Wave:**
1. Run full benchmark suite
2. Manual testing with real Claude Code sessions
3. Track learning curves across multi-day test project
4. Performance profiling and optimization pass
