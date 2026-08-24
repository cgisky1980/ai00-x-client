/**
 * ApplyModal —— 两阶段内测申请弹窗（2026-08-04 约定的完整恢复）
 *
 * 阶段1：名额徽章（时间衰减展示修饰）+「抢内测资格」；真实名额耗尽 → 只显示整点倒计时
 * 阶段2：基本信息（硬件尽力自动检测）+ 趣味题 + 邮箱 → 提交 → 自动发码到邮箱
 *
 * 名额展示修饰：display = max(0, 5*real - 本小时已过秒数/3600*100)（营造陆续有人申请）；
 * 仅「真实剩余 = 0」才禁用抢按钮（展示稀缺仍可抢）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@ai00-x/design-system/react";
import { Modal, Input, Select } from "@ai00-x/design-system/web";
import {
  apiErrorMessage,
  claimSlot,
  fetchQuestions,
  submitApplication,
  type QuestionsData,
} from "./api";
import { detectGpuModel, detectMemoryOption, guessVramOptions } from "./detect";

type Stage = "loading" | "quota" | "form" | "done" | "error";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 本小时已过秒数 */
function elapsedInHour(): number {
  const d = new Date();
  return d.getMinutes() * 60 + d.getSeconds();
}

/** 展示修饰：真实剩余 → 大刻度 + 时间衰减 */
function prettyRemaining(real: number): number {
  const timeDecay = Math.min(100, Math.round((elapsedInHour() / 3600) * 100));
  return Math.max(0, 5 * real - timeDecay);
}

/** 距下一整点的 mm:ss */
function countdownToNextHour(): string {
  const d = new Date();
  const sec = 3599 - (d.getMinutes() * 60 + d.getSeconds());
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function ApplyModal({ open, onClose }: Props) {
  const [stage, setStage] = useState<Stage>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [data, setData] = useState<QuestionsData | null>(null);
  const [displayQuota, setDisplayQuota] = useState(0);
  const [realQuota, setRealQuota] = useState(0);
  const [cd, setCd] = useState("--:--");
  const [grabbing, setGrabbing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [inviteCode, setInviteCode] = useState("");

  // 阶段2 表单状态
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState("");
  const tokenRef = useRef<string>("");

  const loadQuestions = useCallback(async () => {
    setStage("loading");
    setErrorMsg("");
    try {
      const d = await fetchQuestions();
      setData(d);
      const real = Math.max(0, d.hourlyQuota - d.currentHourIssued);
      setRealQuota(real);
      setDisplayQuota(prettyRemaining(real));
      setStage("quota");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "加载失败");
      setStage("error");
    }
  }, []);

  // 打开时加载问卷；关闭时重置（token 作废，名额 10 分钟后由后端懒释放）
  useEffect(() => {
    if (open) {
      tokenRef.current = "";
      setInviteCode("");
      setAnswers({});
      setEmail("");
      setFormError("");
      void loadQuestions();
    }
  }, [open, loadQuestions]);

  // 每秒刷新：展示名额 + 整点倒计时；到整点自动重载
  useEffect(() => {
    if (!open || stage !== "quota") return;
    const t = setInterval(() => {
      setDisplayQuota(prettyRemaining(realQuota));
      setCd(countdownToNextHour());
      if (elapsedInHour() <= 1) void loadQuestions();
    }, 1000);
    return () => clearInterval(t);
  }, [open, stage, realQuota, loadQuestions]);

  // 硬件自动检测预填（阶段2进入时）
  const prefillHardware = useCallback((d: QuestionsData) => {
    setAnswers((prev) => ({
      ...prev,
      gpu_model: prev.gpu_model ?? detectGpuModel(),
      gpu_vram: prev.gpu_vram || guessVramOptions(),
      memory: prev.memory || detectMemoryOption(),
    }));
  }, []);

  const handleGrab = async () => {
    setGrabbing(true);
    setErrorMsg("");
    try {
      const { token } = await claimSlot();
      tokenRef.current = token;
      if (data) prefillHardware(data);
      setStage("form");
    } catch (e) {
      const err = e as Error & { code?: number };
      setErrorMsg(apiErrorMessage(err.code, err.message));
      if (err.code === 4005) void loadQuestions(); // 名额满 → 回阶段1刷新
    } finally {
      setGrabbing(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data) return;
    setFormError("");

    const required = [...data.basicInfo.map((f) => f.key), ...data.questions.map((q) => q.key)];
    const missing = required.filter((k) => !answers[k]?.trim());
    if (missing.length > 0) {
      setFormError("请完整填写所有必填项后再提交");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFormError("请输入有效的邮箱地址（邀请码将发送到该邮箱）");
      return;
    }

    setSubmitting(true);
    try {
      const r = await submitApplication(tokenRef.current, email, answers);
      setInviteCode(r.invite_code);
      setStage("done");
    } catch (err) {
      const e2 = err as Error & { code?: number };
      const msg = apiErrorMessage(e2.code, e2.message);
      setFormError(msg);
      // 资格过期/名额问题 → 回阶段1重新抢
      if (e2.code === 4005 || e2.code === 4006) {
        tokenRef.current = "";
        void loadQuestions();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const quotaBadge = useMemo(
    () => (
      <span className={`hp-quota ${realQuota === 0 ? "is-empty" : ""}`}>
        <span className="hp-quota__label">本小时剩余名额</span>
        <span className="hp-quota__num">{realQuota === 0 ? "0" : displayQuota}</span>
        <span className="hp-quota__cd">
          {realQuota === 0
            ? `名额已满 · ${cd} 后发放新名额`
            : displayQuota <= 2
              ? `仅剩 ${displayQuota} · ${cd} 后补充`
              : `先到先得 · 每小时重置`}
        </span>
      </span>
    ),
    [realQuota, displayQuota, cd],
  );

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={data ? data.title.zh : "申请 Ai00-X 内测邀请"}
      size="medium"
      overlayClassName="hp-apply-overlay"
      closeOnOverlayClick={stage !== "form"}
    >
      <div className="hp-apply">
        {stage === "loading" && <p className="hp-apply__tip">正在加载申请配置…</p>}

        {stage === "error" && (
          <div className="hp-apply__error">
            <p>{errorMsg}</p>
            <Button variant="default" size="base" onClick={() => void loadQuestions()}>重试</Button>
          </div>
        )}

        {/* ---------- 阶段1：名额 + 抢资格 ---------- */}
        {stage === "quota" && data && (
          <div className="hp-apply__stage1">
            <p className="hp-apply__sub">{data.subtitle.zh}</p>
            {quotaBadge}
            {realQuota > 0 ? (
              <Button variant="seal" size="lg" disabled={grabbing} onClick={() => void handleGrab()}>
                {grabbing ? "正在抢资格…" : "抢内测资格"}
              </Button>
            ) : (
              <p className="hp-apply__tip">本小时名额已发完，倒计时结束后可再抢（名额不累计，每小时独立）。</p>
            )}
            {errorMsg && realQuota > 0 && <p className="hp-apply__err">{errorMsg}</p>}
          </div>
        )}

        {/* ---------- 阶段2：基本信息 + 问卷 + 邮箱 ---------- */}
        {stage === "form" && data && (
          <form id="hp-apply-form" className="hp-apply__form" onSubmit={handleSubmit}>
            <p className="hp-apply__sub">已为你预留资格（10 分钟内有效），填写完成后邀请码将自动发送到邮箱。</p>

            <fieldset className="hp-apply__group hp-apply__group--basic">
              <legend>基本信息（硬件已自动检测，可修改）</legend>
              {data.basicInfo.map((f) => (
                <div key={f.key} className={`hp-apply__field ${f.type === "text" ? "hp-apply__field--text" : ""}`}>
                  {f.type === "select" ? (
                    <Select
                      label={f.title.zh}
                      options={(f.options ?? []).map((o) => ({ label: o.label.zh, value: o.value }))}
                      value={answers[f.key] ?? ""}
                      onChange={(v) => setAnswers((p) => ({ ...p, [f.key]: String(v) }))}
                    />
                  ) : (
                    <Input
                      label={f.title.zh}
                      hint={f.help?.zh}
                      placeholder={f.placeholder?.zh ?? ""}
                      value={answers[f.key] ?? ""}
                      onChange={(e) => setAnswers((p) => ({ ...p, [f.key]: e.target.value }))}
                    />
                  )}
                </div>
              ))}
            </fieldset>

            <fieldset className="hp-apply__group">
              <legend>趣味问卷</legend>
              {data.questions.map((q, i) => (
                <div key={q.key} className="hp-apply__q">
                  <div className="hp-apply__q-title">
                    <span className="n">{String(i + 1).padStart(2, "0")}</span>
                    {q.title.zh}
                  </div>
                  <div className="hp-apply__opts" role="radiogroup" aria-label={q.title.zh}>
                    {q.options.map((o) => (
                      <label key={o.value} className={`hp-opt ${answers[q.key] === o.value ? "is-on" : ""}`}>
                        <input
                          type="radio"
                          name={q.key}
                          value={o.value}
                          checked={answers[q.key] === o.value}
                          onChange={() => setAnswers((p) => ({ ...p, [q.key]: o.value }))}
                        />
                        {o.label.zh}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </fieldset>

            <Input
              label="你的邮箱（用于接收邀请码）"
              placeholder="you@example.com"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={!!formError}
            />

            {formError && <p className="hp-apply__err">{formError}</p>}
          </form>
        )}

        {stage === "form" && (
          <div className="hp-apply__footer">
            <span className="hp-apply__footer-hint">资格 10 分钟内有效</span>
            <Button type="submit" variant="primary" size="base" disabled={submitting} form="hp-apply-form">
              {submitting ? "正在提交…" : "提交申请"}
            </Button>
          </div>
        )}

        {/* ---------- 完成：邀请码已发 ---------- */}
        {stage === "done" && (
          <div className="hp-apply__done">
            <p className="hp-apply__done-title">申请成功，邀请码已发送</p>
            <p className="hp-apply__code">{inviteCode}</p>
            <p className="hp-apply__tip">请到 <strong>{email}</strong> 查收邮件；若未收到请检查垃圾箱。</p>
            <Button variant="default" size="base" onClick={onClose}>完成</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
