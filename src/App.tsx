import React, { useEffect, useMemo, useState } from "react";

type QualitySummary = {
  source:
    | "monitoring"
    | "symptoms"
    | "iot"
    | "category_vitals"
    | "category_symptoms"
    | "category_miscellaneous";
  status: "ok" | "missing" | "stale" | "conflicting" | "error";
  note?: string;
};

type LatencyBreakdown = {
  monitoring_fetch_ms: number;
  clinical_kb_ms: number;
  context_compose_ms: number;
  total_ms: number;
};

type GenerateContextRequest = {
  patient_id: string;
  session_id: string;
  specialty: string;
  result_count: number;
};

type GenerateContextResponse = {
  patient_id: string;
  session_id: string;
  context_block: string;
  sources_used: string[];
  quality_summary: QualitySummary[];
  caution_flags?: string[];
  clinical_guidelines_used?: string[];
  latencies?: LatencyBreakdown;
  generated_at: string;
};

type EvalSummaryFlat = {
  cases_evaluated: number;
  llm_used_pct: number;
  fallback_used_pct: number;
  validation_failed_pct: number;
  avg_grounding_score: number | null;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  slow_case_count: number;
  top_failure_reason: string | null;
  top_failure_reason_count: number;
  failure_reason_counts: Record<string, number>;
  case_count_with_failures: number;
};

type EvalSummaryRich = {
  run_timestamp: string | null;
  cases_evaluated: number;
  pipeline_behavior: {
    llm_used_pct: number;
    fallback_used_pct: number;
    validation_failed_pct: number;
  };
  avg_grounding_score: number | null;
  hallucination: {
    avg_support_ratio: number | null;
    total_unsupported_claims: number;
    hallucination_category_counts: Record<string, number>;
  };
  ragas: {
    avg_faithfulness_score: number | null;
    evaluated_count: number;
    error_count: number;
  };
  latency: {
    avg_latency_ms: number | null;
    p95_latency_ms: number | null;
    slow_case_count: number;
  };
  failure_reason_counts: Record<string, number>;
};

type HallucinationCategoriesResponse = {
  category_counts: Record<string, number>;
  samples_by_case: Record<string, Array<{ type?: string; text?: string; reason?: string; source?: string }>>;
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

const improvedContextPreview = [
  "0. Overall Context Summary",
  "This preview keeps the same visible structure as the backend output: one concise overall summary followed by five detailed sections for nurse-intake readability.",
  "1. Current Patient Status",
  "Use the generator above to create a live patient context block that preserves grounded patient conditions, medications, and current monitoring details.",
  "2. Key Trends",
  "Recent trends should capture what is changing or persisting across sessions, such as weight pattern, blood pressure direction, heart-rate movement, and adherence signals.",
  "3. Clinical Context for Intake",
  "This section should explain why the current patient-specific picture matters for nurse questioning without diagnosing or giving treatment advice.",
  "4. Focus Areas for Intake Agent",
  "This section should list the highest-priority follow-up topics the nurse agent should ask about first based on the personalized context.",
  "5. Missing Information",
  "This section should explicitly state what important assessment details are currently missing and need clarification during intake.",
];

function formatMs(ms?: number | null): string {
  if (ms === undefined || ms === null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms} ms`;
}

function formatContextBlock(text?: string): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function formatPct(value?: number | null): string {
  if (value === undefined || value === null) return "—";
  return `${value.toFixed(1)}%`;
}

function formatScore(value?: number | null): string {
  if (value === undefined || value === null) return "—";
  return value.toFixed(2);
}

function titleizeReason(reason?: string | null): string {
  if (!reason) return "—";
  return reason.replaceAll("_", " ");
}

export default function App(): JSX.Element {
  const [patientId, setPatientId] = useState<string>("703307184");
  const [sessionId, setSessionId] = useState<string>("session-ra-001");
  const [specialty, setSpecialty] = useState<string>("rheumatology");
  const [resultCount, setResultCount] = useState<number>(3);
  const [loading, setLoading] = useState<boolean>(false);
  const [evalLoading, setEvalLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [generatedContext, setGeneratedContext] =
    useState<GenerateContextResponse | null>(null);
  const [evalFlat, setEvalFlat] = useState<EvalSummaryFlat | null>(null);
  const [evalRich, setEvalRich] = useState<EvalSummaryRich | null>(null);
  const [hallucinationCategories, setHallucinationCategories] =
    useState<HallucinationCategoriesResponse | null>(null);

  const contextLines = useMemo<string[]>(() => {
    return formatContextBlock(generatedContext?.context_block);
  }, [generatedContext]);

  const topHallucinationCategories = useMemo(() => {
    const counts = hallucinationCategories?.category_counts || {};
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  }, [hallucinationCategories]);

  useEffect(() => {
    async function loadEvalData(): Promise<void> {
      setEvalLoading(true);
      try {
        const [flatRes, richRes, catRes] = await Promise.all([
          fetch(`${API_BASE_URL}/evolko_ai_api/v1/evals/patient-context/summary/flat`),
          fetch(`${API_BASE_URL}/evolko_ai_api/v1/evals/patient-context/summary`),
          fetch(`${API_BASE_URL}/evolko_ai_api/v1/evals/patient-context/hallucination-categories`),
        ]);

        if (flatRes.ok) {
          setEvalFlat((await flatRes.json()) as EvalSummaryFlat);
        }
        if (richRes.ok) {
          setEvalRich((await richRes.json()) as EvalSummaryRich);
        }
        if (catRes.ok) {
          setHallucinationCategories(
            (await catRes.json()) as HallucinationCategoriesResponse,
          );
        }
      } catch {
        // keep UI usable even if eval endpoints are temporarily unavailable
      } finally {
        setEvalLoading(false);
      }
    }

    void loadEvalData();
  }, []);

  async function handleGenerateContext(
    e: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const payload: GenerateContextRequest = {
        patient_id: patientId,
        session_id: sessionId,
        specialty,
        result_count: resultCount,
      };

      const res = await fetch(
        `${API_BASE_URL}/evolko_ai_api/v1/generate_context`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Context generation failed: ${res.status} ${text}`);
      }

      const json = (await res.json()) as GenerateContextResponse;
      setGeneratedContext(json);
    } catch (err: unknown) {
      setGeneratedContext(null);
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to generate patient context.");
      }
    } finally {
      setLoading(false);
    }
  }

  const latencies: LatencyBreakdown | undefined = generatedContext?.latencies;

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Patient Context Dashboard</h1>
          <p>
            Live patient-context generation plus backend-backed evaluation,
            groundedness, unsupported-claim controls, and latency metrics.
          </p>
        </div>
        <div className="status-pill">
          {evalLoading ? "Loading evals..." : "Backend metrics live"}
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="hero-grid">
        <div className="card hero-card">
          <div className="panel-header compact-header">
            <h2>Backend Evaluation Snapshot</h2>
            <span className="panel-badge">Real metrics</span>
          </div>
          <div className="metric-grid">
            <div className="metric-card">
              <span className="metric-label">Cases evaluated</span>
              <strong className="metric-value">
                {evalFlat?.cases_evaluated ?? "—"}
              </strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Avg grounding score</span>
              <strong className="metric-value">
                {formatScore(evalFlat?.avg_grounding_score)}
              </strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Validation failed</span>
              <strong className="metric-value">
                {formatPct(evalFlat?.validation_failed_pct)}
              </strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">P95 latency</span>
              <strong className="metric-value">
                {formatMs(evalFlat?.p95_latency_ms)}
              </strong>
            </div>
          </div>
          <div className="insight-row">
            <div className="insight-box insight-good">
              <span className="insight-title">Pipeline behavior</span>
              <p>
                LLM used: {formatPct(evalFlat?.llm_used_pct)} · Fallback used:{" "}
                {formatPct(evalFlat?.fallback_used_pct)}
              </p>
            </div>
            <div className="insight-box insight-risk">
              <span className="insight-title">Top failure signal</span>
              <p>
                {titleizeReason(evalFlat?.top_failure_reason)}{" "}
                {evalFlat?.top_failure_reason_count
                  ? `(${evalFlat.top_failure_reason_count} cases)`
                  : ""}
              </p>
            </div>
          </div>
        </div>

        <div className="card hero-card">
          <div className="panel-header compact-header">
            <h2>Unsupported-Claim &amp; Groundedness Controls</h2>
            <span className="panel-badge badge-muted">Demo-ready</span>
          </div>
          <div className="control-stack">
            <div className="control-card">
              <div className="quality-top">
                <strong>Avg support ratio</strong>
                <span className="quality-status">
                  {formatScore(evalRich?.hallucination.avg_support_ratio)}
                </span>
              </div>
              <p>
                Deterministic claim-to-evidence support score across evaluated
                patient-context runs.
              </p>
            </div>
            <div className="control-card">
              <div className="quality-top">
                <strong>Total unsupported claims</strong>
                <span className="quality-status">
                  {evalRich?.hallucination.total_unsupported_claims ?? "—"}
                </span>
              </div>
              <p>
                Backend-detected unsupported claims from the deterministic
                unsupported-claim layer. This is not presented as a final
                hallucination percentage.
              </p>
            </div>
            <div className="control-card">
              <div className="quality-top">
                <strong>Top categories</strong>
                <span className="quality-status">
                  {topHallucinationCategories.length}
                </span>
              </div>
              <p>
                {topHallucinationCategories.length > 0
                  ? topHallucinationCategories
                      .map(([k, v]) => `${k.replaceAll("_", " ")} (${v})`)
                      .join(", ")
                  : "No unsupported-claim categories available yet."}
              </p>
            </div>
            <div className="control-card">
              <div className="quality-top">
                <strong>RAGAS faithfulness</strong>
                <span className="quality-status">
                  {evalRich?.ragas.evaluated_count
                    ? formatScore(evalRich?.ragas.avg_faithfulness_score)
                    : "offline / pending"}
                </span>
              </div>
              <p>
                Secondary semantic faithfulness layer. Primary safety signals
                remain deterministic groundedness and unsupported-claim checks.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="main-grid">
        <section className="left-column">
          <form className="card form-card" onSubmit={handleGenerateContext}>
            <div className="panel-header">
              <h2>Patient Context Generator</h2>
              <span className="panel-badge">Primary Flow</span>
            </div>

            <div className="form-grid">
              <div>
                <label htmlFor="patientId">Patient ID</label>
                <input
                  id="patientId"
                  value={patientId}
                  onChange={(e) => setPatientId(e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="sessionId">Session ID</label>
                <input
                  id="sessionId"
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="specialty">Specialty</label>
                <input
                  id="specialty"
                  value={specialty}
                  onChange={(e) => setSpecialty(e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="resultCount">Result Count</label>
                <input
                  id="resultCount"
                  type="number"
                  min={1}
                  max={20}
                  value={resultCount}
                  onChange={(e) => setResultCount(Number(e.target.value) || 3)}
                />
              </div>
            </div>

            <div className="form-actions">
              <button type="submit" disabled={loading}>
                {loading
                  ? "Generating Patient Context..."
                  : "Generate Patient Context"}
              </button>
            </div>
          </form>

          <section className="card primary-panel">
            <div className="panel-header">
              <h2>Generated Patient Context</h2>
              <span className="panel-badge">
                {generatedContext && generatedContext.sources_used.length > 0
                  ? generatedContext.sources_used.join(", ")
                  : "Live output or preview"}
              </span>
            </div>

            {loading ? (
              <p className="empty-state">Generating patient context...</p>
            ) : generatedContext ? (
              <div className="context-render">
                {contextLines.map((line, index) => {
                  const isSection = /^\d+\./.test(line);
                  return isSection ? (
                    <h3 key={index} className="context-section">
                      {line}
                    </h3>
                  ) : (
                    <p key={index} className="context-line">
                      {line}
                    </p>
                  );
                })}
              </div>
            ) : (
              <div className="context-render">
                {improvedContextPreview.map((line, index) => {
                  const isSection = /^\d+\./.test(line);
                  return isSection ? (
                    <h3 key={index} className="context-section">
                      {line}
                    </h3>
                  ) : (
                    <p key={index} className="context-line">
                      {line}
                    </p>
                  );
                })}
              </div>
            )}
          </section>

          <section className="card">
            <div className="panel-header compact-header">
              <h3>Source Quality</h3>
              <span className="panel-badge badge-muted">
                {generatedContext ? generatedContext.quality_summary.length : 3}{" "}
                checks
              </span>
            </div>

            {!generatedContext || generatedContext.quality_summary.length === 0 ? (
              <div className="quality-grid">
                <div className="quality-card quality-ok">
                  <div className="quality-top">
                    <strong>monitoring</strong>
                    <span className="quality-status">ok</span>
                  </div>
                  <p>
                    Deterministic monitoring extraction remains the source of
                    truth for factual patient signals.
                  </p>
                </div>
                <div className="quality-card quality-conflicting">
                  <div className="quality-top">
                    <strong>clinical_kb</strong>
                    <span className="quality-status">measured</span>
                  </div>
                  <p>
                    Retrieval evidence now feeds both evaluation metrics and
                    unsupported-claim checks.
                  </p>
                </div>
                <div className="quality-card quality-stale">
                  <div className="quality-top">
                    <strong>groundedness</strong>
                    <span className="quality-status">watch</span>
                  </div>
                  <p>
                    Weak grounding and unsupported-claim categories are visible
                    in the top cards instead of hidden behind narrative polish.
                  </p>
                </div>
              </div>
            ) : (
              <div className="quality-grid">
                {generatedContext.quality_summary.map((item, index) => (
                  <div
                    key={`${item.source}-${index}`}
                    className={`quality-card quality-${item.status}`}
                  >
                    <div className="quality-top">
                      <strong>{item.source}</strong>
                      <span className="quality-status">{item.status}</span>
                    </div>
                    <p>{item.note ? item.note : "No issues reported."}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </section>

        <aside className="side-column">
          <section className="card">
            <div className="panel-header">
              <h2>Latency Breakdown</h2>
              <span className="panel-badge">Backend</span>
            </div>

            <div className="latency-grid">
              <div className="latency-row">
                <span>Monitoring Fetch</span>
                <strong>{formatMs(latencies?.monitoring_fetch_ms)}</strong>
              </div>

              <div className="latency-row">
                <span>Clinical KB</span>
                <strong>{formatMs(latencies?.clinical_kb_ms)}</strong>
              </div>

              <div className="latency-row">
                <span>Context Compose</span>
                <strong>{formatMs(latencies?.context_compose_ms)}</strong>
              </div>

              <div className="latency-row latency-total">
                <span>Total</span>
                <strong>{formatMs(latencies?.total_ms)}</strong>
              </div>
            </div>

            {!latencies ? (
              <p className="empty-state latency-note">
                No live latency yet. The evaluation cards above are already
                driven by real backend metrics.
              </p>
            ) : null}
          </section>

          <section className="card">
            <div className="panel-header compact-header">
              <h3>Evaluation Highlights</h3>
              <span className="panel-badge badge-muted">
                {evalFlat?.cases_evaluated ?? 0} cases
              </span>
            </div>

            <div className="metadata-stack">
              <div className="latency-row">
                <span>Slow cases &gt; 60s</span>
                <strong>{evalFlat?.slow_case_count ?? "—"}</strong>
              </div>
              <div className="latency-row">
                <span>Cases with failures</span>
                <strong>{evalFlat?.case_count_with_failures ?? "—"}</strong>
              </div>
              <div className="latency-row">
                <span>Unsupported claims</span>
                <strong>
                  {evalRich?.hallucination.total_unsupported_claims ?? "—"}
                </strong>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="panel-header compact-header">
              <h3>Response Metadata</h3>
              <span className="panel-badge badge-muted">
                {generatedContext?.generated_at ? "Available" : "Pending"}
              </span>
            </div>

            {!generatedContext ? (
              <p className="empty-state">No live response metadata yet.</p>
            ) : (
              <div className="metadata-stack">
                <div className="latency-row">
                  <span>Generated At</span>
                  <strong>
                    {new Date(generatedContext.generated_at).toLocaleString()}
                  </strong>
                </div>

                <div className="latency-row">
                  <span>Sources Used</span>
                  <strong>
                    {generatedContext.sources_used.length > 0
                      ? generatedContext.sources_used.join(", ")
                      : "—"}
                  </strong>
                </div>

                <div className="latency-row">
                  <span>Caution Flags</span>
                  <strong>{generatedContext.caution_flags?.length ?? 0}</strong>
                </div>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
