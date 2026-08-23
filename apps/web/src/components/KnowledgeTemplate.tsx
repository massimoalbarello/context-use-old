import {
  summarizeTemplateResult,
  type KnowledgePreparationResponse,
  type KnowledgePreparationScope,
  type TemplateAction,
  type TemplateResult,
  type TemplateSummary,
} from "@context-use/shared";
import { useState } from "react";
import { api } from "../api.ts";
import { ActionDialog } from "./ActionDialog.tsx";

function actionSymbol(action: TemplateAction): string {
  if (action.action === "conflict") return "!";
  if (action.action.startsWith("create")) return "+";
  return "~";
}

function actionDetail(action: TemplateAction): string {
  return action.detail.replace(/\bdirector(?:y|ies)\b/gi, (value) =>
    value.toLowerCase() === "directories" ? "collections" : "collection");
}

export function TemplatePlan({ result }: { result: TemplateResult }) {
  const summary = summarizeTemplateResult(result);
  const visibleActions = result.actions.filter(({ action }) => action !== "unchanged");

  if (!visibleActions.length) {
    return <div className="template-current"><span aria-hidden="true">✓</span><div><strong>Template is current</strong><small>Your knowledge base matches the default template bundled with this release.</small></div></div>;
  }

  return <div className="template-plan">
    <div className="template-summary" aria-label="Template plan summary">
      <span><strong>{summary.changes}</strong> change{summary.changes === 1 ? "" : "s"}</span>
      <span className={summary.conflicts ? "has-conflicts" : ""}><strong>{summary.conflicts}</strong> conflict{summary.conflicts === 1 ? "" : "s"}</span>
      {summary.replacements > 0 && <span className="has-replacements"><strong>{summary.replacements}</strong> local replacement{summary.replacements === 1 ? "" : "s"}</span>}
    </div>
    <ul className="template-actions">
      {visibleActions.map((action, index) => <li className={action.action === "conflict" ? "conflict" : action.replaces_local ? "replacement" : ""} key={`${action.action}:${action.path}:${index}`}>
        <span className="template-action-symbol" aria-hidden="true">{actionSymbol(action)}</span>
        <div><span>{actionDetail(action)}</span></div>
      </li>)}
    </ul>
  </div>;
}

export function KnowledgePreparationScopeNotice({
  scope,
}: {
  scope: KnowledgePreparationScope;
}) {
  if (scope.managed_operational_documents !== "deployment_one_shot"
      || scope.hypermedia_corpus !== "deployment_one_shot") return null;
  return <p className="template-preparation-scope"><strong>Full knowledge preparation still requires the isolated deployment one-shot.</strong> Changes applied here only reconcile eligible template-owned pages. Run <code>context-use knowledge-template apply</code> or redeploy Context Use to reconcile private operational documents and audit the hypermedia corpus. Owner-authored pages and pinned public revisions remain protected.</p>;
}

export function preparationActionLabel(
  _summary: TemplateSummary,
  _forceTemplate: boolean,
): string {
  return "Apply template changes";
}

export function canApplyTemplateChanges(
  summary: TemplateSummary,
  forceTemplate: boolean,
): boolean {
  return summary.changes > 0 || forceTemplate;
}

export function KnowledgeTemplateSettings({
  onKnowledgeChanged,
}: {
  onKnowledgeChanged: () => Promise<void>;
}) {
  const [plan, setPlan] = useState<KnowledgePreparationResponse | null>(null);
  const [forceTemplate, setForceTemplate] = useState(false);
  const [plannedForce, setPlannedForce] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [message, setMessage] = useState("");

  const loadPlan = async (force: boolean) => {
    setChecking(true);
    setCheckError("");
    setMessage("");
    try {
      const suffix = force ? "?force_template=true" : "";
      setPlan(await api<KnowledgePreparationResponse>(`/api/dashboard/knowledge-template/plan${suffix}`));
      setPlannedForce(force);
    } catch (error) {
      setPlan(null);
      setCheckError(error instanceof Error ? error.message : "Could not check the knowledge template");
    } finally {
      setChecking(false);
    }
  };

  const checkForUpdates = async () => {
    setForceTemplate(false);
    await loadPlan(false);
  };

  const changeForceTemplate = async (force: boolean) => {
    setForceTemplate(force);
    await loadPlan(force);
  };

  const applyTemplate = async () => {
    if (!plan) return;
    setApplying(true);
    setApplyError("");
    try {
      const result = await api<KnowledgePreparationResponse>("/api/dashboard/knowledge-template/apply", {
        method: "POST",
        body: JSON.stringify({ force_template: forceTemplate }),
      });
      const summary = summarizeTemplateResult(result);
      setConfirming(false);
      setForceTemplate(false);
      setPlannedForce(false);
      setMessage(`Template reconciliation completed. Applied ${summary.changes} template change${summary.changes === 1 ? "" : "s"}.${summary.conflicts ? ` Preserved ${summary.conflicts} conflict${summary.conflicts === 1 ? "" : "s"}.` : ""} Full knowledge preparation remains pending; run context-use knowledge-template apply or redeploy.`);
      await onKnowledgeChanged().catch(() => undefined);
      try {
        setPlan(await api<KnowledgePreparationResponse>("/api/dashboard/knowledge-template/plan"));
      } catch {
        setPlan(null);
        setCheckError("The template was applied, but its current status could not be rechecked.");
      }
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : "Could not apply the knowledge template");
    } finally {
      setApplying(false);
    }
  };

  const summary = plan ? summarizeTemplateResult(plan) : null;
  const planMatchesChoice = plannedForce === forceTemplate;

  return <section className="template-settings">
    <h2>Knowledge template</h2>
    <p>Compare your knowledge base with the latest default template included in this Context Use release. Local edits are reported as conflicts and preserved unless you explicitly choose to replace eligible customizations.</p>
    <button className="primary" disabled={checking || applying} onClick={() => void checkForUpdates()}>{checking && !plan ? "Checking…" : "Check for template updates"}</button>
    {checkError && <p className="error" role="alert">{checkError}</p>}
    {message && <p className="template-message" role="status">{message}</p>}
    {plan && <div className={`template-result${checking ? " checking" : ""}`} aria-busy={checking}>
      <TemplatePlan result={plan} />
      <KnowledgePreparationScopeNotice scope={plan.preparation_scope} />
      {(summary!.conflicts > 0 || forceTemplate) && <label className="template-force-option">
        <input type="checkbox" checked={forceTemplate} disabled={checking || applying} onChange={(event) => void changeForceTemplate(event.currentTarget.checked)} />
        <span><strong>Replace eligible template-owned customizations</strong><small>Preview and overwrite eligible template-owned collection metadata and managed pages. Owner-authored guides and control documents, published or archived content, and create-only state remain protected.</small></span>
      </label>}
      <div className="template-controls">
        {canApplyTemplateChanges(summary!, forceTemplate) && <button className={forceTemplate ? "danger" : "primary"} disabled={checking || applying || !planMatchesChoice} onClick={() => { setApplyError(""); setConfirming(true); }}>
          {preparationActionLabel(summary!, forceTemplate)}
        </button>}
        {checking && <span>Refreshing preview…</span>}
      </div>
    </div>}
    {confirming && plan && <ActionDialog
      eyebrow="Knowledge template"
      title={forceTemplate
        ? "Force this template update?"
        : "Apply these template changes?"}
      description={forceTemplate
        ? `Apply ${summary!.changes} changes, including ${summary!.replacements} eligible local replacement${summary!.replacements === 1 ? "" : "s"}. Content protected by ${summary!.conflicts} remaining conflict${summary!.conflicts === 1 ? "" : "s"} will be preserved. Run context-use knowledge-template apply or redeploy afterward to complete isolated preparation.`
        : `Apply ${summary!.changes} safe template change${summary!.changes === 1 ? "" : "s"}. ${summary!.conflicts} local conflict${summary!.conflicts === 1 ? "" : "s"} will be preserved. Run context-use knowledge-template apply or redeploy afterward to complete isolated preparation.`}
      confirmLabel="Apply template changes"
      workingLabel="Applying template…"
      confirmTone={forceTemplate ? "danger" : "primary"}
      working={applying}
      error={applyError}
      onCancel={() => { setApplyError(""); setConfirming(false); }}
      onConfirm={() => void applyTemplate()}
    />}
  </section>;
}
