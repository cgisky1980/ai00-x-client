//! RWKV-7 **候选打分**（Jev 式「单次前向、零生成 token」）。
//!
//! ⚠ 本文件是 `mytown/rwkv-choose/src/lib.rs` 的**逐行拷贝**（vendored copy）：desktop
//! 是独立仓库，path 依赖 mytown 会让它的 CI 断链（`rwkv-rsv` 靠 workflow clone 才成立，
//! mytown 不在其列）。两份实现**必须同语义**——防漂移的闸不是自觉，是
//! `参考/` 里那份两侧对拍（同 prompt 同候选，排名一致、分数差 <5e-3）。
//! 改动数学口径请先改 mytown 那份，再原样同步过来。
//!
//! 语义规格照抄 `ai00_server/crates/ai00-core/src/run.rs` 的 choose 驱动，**含它的三处
//! quirk**（见 [`Candidate`] 上方与 [`score_candidates`] 的 ⚠ 列表）——这里不做「顺手改进」，
//! 改进会让两侧分数不可对拍。宿主（这里是 `rwkv_llm` 的 pool 线程）负责持有 tokenizer
//! 与模板渲染，本模块只在**已分词**的 prompt / candidates 上算分。
//!
//! 走的是**串行** `forward_with_state`（不依赖批量内核）：候选短（决策场景
//! `{"answer":"C"}` ≈ 6–8 token），批量扇出反而被每槽 ~21MB 的 `state_slot_load` PCIe
//! 流量主导。等实测口径变了再立项。
//!
//! 打分的口径是「**只看 prompt**」：[`score_candidates`] 入口先 `reset` 状态，因此同一
//! 请求连打两次结果一致，也不会被宿主上一次推理（生成或打分）残留的状态污染。

use rwkv_rsv::gpu_model::{GpuModel, State};

/// 一个候选：文本 + **已分词**的 token（文本原样编码，不注入前导空格）。
///
/// ★ 三处照抄参照（`ai00-core/src/run.rs` 的 choose 驱动）的 quirk，改任何一处都会让
/// 两侧分数不可对拍：`perplexity` 其实是平均 NLL、空候选留 `+inf`、`calibrate` 除数 `L+1`。
/// 逐条口径写在 [`score_candidates`] 的 doc 上。
#[derive(Debug, Clone)]
pub struct Candidate<'a> {
    /// 原样文本（回显用，不参与计算）。
    pub text: &'a str,
    /// 原样分词结果。⚠ `" Paris"` 这类**前导空格由调用方保留在文本里**，本模块
    /// 不做任何归一化——参照实现也是逐候选独立编码。
    pub tokens: &'a [u32],
}

/// 一个候选的打分结果。字段名 `perplexity` 沿用参照响应（它实际是**平均 NLL**）。
#[derive(Debug, Clone)]
pub struct ChoiceScore {
    /// 在输入 `candidates` 里的下标（排序后仍可回溯）。
    pub index: usize,
    /// 升序名次（`0` = 最优）。放在模块里而不是让宿主各自 `enumerate`，是为了让
    /// `/v1/chooses` 的 `rank` 字段在两个 host 里同源。
    pub rank: usize,
    /// 候选原文本。
    pub choice: String,
    /// 平均 NLL，**越小越优**；空候选为 `f32::INFINITY`。
    pub perplexity: f32,
}

/// 打分需要的最小模型能力面（把「打分数学」与「驱动 GpuModel」解耦，前者可无 GPU 单测）。
pub trait TokenScorer {
    /// 消费整段 prompt，返回**末位** logits（即预测候选第 1 个 token 的分布）。
    fn prefill(&mut self, prompt: &[u32]) -> Result<Vec<f32>, String>;
    /// 消费若干 token（候选内部逐 1 个调），返回末位 logits。
    fn step(&mut self, tokens: &[u32]) -> Result<Vec<f32>, String>;
    /// 状态快照（宿主侧的中性序列化形式：本模块只把它当 opaque `Vec<f32>` 搬运）。
    fn snapshot(&mut self) -> Result<Vec<f32>, String>;
    /// 回灌快照。
    fn restore(&mut self, snap: &[f32]) -> Result<(), String>;
    /// 回到**零/初始**状态（[`score_candidates`] 入口用它保证「只看 prompt」，
    /// `calibrate` 的无条件打分也用它）。
    fn reset(&mut self) -> Result<(), String>;
}

/// [`ModelScorer`]：把 `GpuModel` + 一个调用方持有的 `State` 适配到 [`TokenScorer`]。
pub struct ModelScorer<'a> {
    model: &'a mut GpuModel,
    state: &'a mut State,
}

impl<'a> ModelScorer<'a> {
    pub fn new(model: &'a mut GpuModel, state: &'a mut State) -> Self {
        Self { model, state }
    }
}

impl TokenScorer for ModelScorer<'_> {
    fn prefill(&mut self, prompt: &[u32]) -> Result<Vec<f32>, String> {
        // 序列并行 prefill：一次贯穿整段 prompt，只回末位 logits（正是这里要的）。
        self.model
            .forward_seq_with_state(self.state, prompt)
            .map_err(|e| format!("choose prefill 失败: {e}"))
    }

    fn step(&mut self, tokens: &[u32]) -> Result<Vec<f32>, String> {
        self.model
            .forward_with_state(self.state, tokens)
            .map_err(|e| format!("choose step 失败: {e}"))
    }

    fn snapshot(&mut self) -> Result<Vec<f32>, String> {
        self.model
            .state_back(self.state)
            .map_err(|e| format!("choose 状态快照失败: {e}"))
    }

    fn restore(&mut self, snap: &[f32]) -> Result<(), String> {
        self.model
            .state_load(self.state, snap)
            .map_err(|e| format!("choose 状态回灌失败: {e}"))
    }

    fn reset(&mut self) -> Result<(), String> {
        self.model
            .reset_state_of(self.state)
            .map_err(|e| format!("choose 状态清零失败: {e}"))
    }
}

/// `ln p(tok | logits)`，数值稳定写法（减 max 再 exp）。
///
/// 参照实现用裸 `exp()` 再归一，数学等价；对拍容差按 1e-3 级看。
/// `tok` 越界返回 Err（宿主的 vocab 与 logits 长度必须一致）。
pub fn log_prob(logits: &[f32], tok: usize) -> Result<f64, String> {
    if logits.is_empty() {
        return Err("log_prob: 空 logits".into());
    }
    if tok >= logits.len() {
        return Err(format!(
            "log_prob: token 索引 {tok} 越界（vocab={}）",
            logits.len()
        ));
    }
    let max = f64::from(logits.iter().copied().fold(f32::NEG_INFINITY, f32::max));
    let mut sum = 0.0f64;
    for &x in logits {
        sum += (f64::from(x) - max).exp();
    }
    Ok(f64::from(logits[tok]) - max - sum.ln())
}

/// 从**已就绪**的 logits（预测 `tokens[0]`）开始，逐个消费 `tokens` 累加 `ln p`。
///
/// 只在还有下一个 token 时才前向——最后一个 token 的 logits 没人用，省一步。
pub fn logprob_chain<S: TokenScorer>(
    scorer: &mut S,
    first_logits: &[f32],
    tokens: &[u32],
) -> Result<f64, String> {
    let mut logits = first_logits.to_vec();
    let mut total = 0.0f64;
    for (k, &t) in tokens.iter().enumerate() {
        total += log_prob(&logits, t as usize)?;
        if k + 1 < tokens.len() {
            logits = scorer.step(&[t])?;
        }
    }
    Ok(total)
}

/// 单候选的**条件**平均 NLL：`-(1/L) Σ ln p_k`。空候选返回 `+inf`。
pub fn mean_nll<S: TokenScorer>(
    scorer: &mut S,
    first_logits: &[f32],
    tokens: &[u32],
) -> Result<f32, String> {
    if tokens.is_empty() {
        return Ok(f32::INFINITY);
    }
    let lp = logprob_chain(scorer, first_logits, tokens)?;
    Ok((-(lp / tokens.len() as f64)) as f32)
}

/// `calibrate` 项：候选在**零态**上的无条件 `Σ ln p / (L+1)`（负值，最终分**加上**它
/// = 减去候选自身的流畅度）。
///
/// ⚠ 参照实现（`run.rs:700-755`）在这里把序列换成 `[0] ++ tokens`，那个前置 `0` 只把
/// 状态从净零推进一格、**不进分子**，而**除数用 `L+1`** 而不是 `L`（分子只有 L 项）——
/// 这是它的口径，照抄不改（除数一改两侧分数就不可对拍）。
pub fn calibrate_term<S: TokenScorer>(scorer: &mut S, tokens: &[u32]) -> Result<f32, String> {
    if tokens.is_empty() {
        return Ok(0.0);
    }
    scorer.reset()?;
    // 前置的 0 只推进状态；它的 ln p 不入分子（参照的 index 从 1 起）。
    let logits = scorer.step(&[0])?;
    let lp = logprob_chain(scorer, &logits, tokens)?;
    Ok((lp / (tokens.len() + 1) as f64) as f32)
}

/// 在已分词的 prompt / candidates 上打分，返回**按分数升序**（越小越优）排列的结果。
///
/// 口径（★ = 参照的 quirk，刻意保留）：
/// - `p_1` 取 prompt 末位 logits 的 softmax 在 `c_1` 处的概率；`p_k (k≥2)` 取状态消费
///   `c_1..c_{k-1}` 之后的 logits。★ 候选**各自独立**地从 prompt 末端快照起跑，
///   互不影响（不是把 N 个候选串成一条长序列）。
/// - `score = -(1/L) Σ ln p_k`，字段名叫 `perplexity` 但**不是** exp 域困惑度。★
/// - 空候选：跳过打分，分数留 `+inf`，排在最后。
/// - `calibrate=true`：另在零态上按 ★ `[0] ++ c` 且**除数 `L+1`** 算流畅度项并加上。
///
/// 调用约定：入口先 `reset()`——打分口径定义为「**只看 prompt** 的条件分布」，不继承
/// 上一次推理留下的状态。宿主若省了这一步，同一请求两次结果就会不同（mytown 实测：
/// 连打两次 `/v1/chooses`，中文四城分数漂移且名次互换），所以把它做成算法性质、
/// 而不是各宿主的自觉。
///
/// `state` 由宿主持有并在调用后被视为**宿主所有**——本函数会把它的状态推进到
/// 「最后一次打分趟的末尾」，不复原；宿主生成路径每次进来也 reset，故互不污染。
pub fn score_candidates<S: TokenScorer>(
    scorer: &mut S,
    prompt: &[u32],
    candidates: &[Candidate],
    calibrate: bool,
) -> Result<Vec<ChoiceScore>, String> {
    if prompt.is_empty() {
        return Err("choose: prompt 分词结果为空".into());
    }
    scorer.reset()?;
    let first_logits = scorer.prefill(prompt)?;
    let snap = scorer.snapshot()?;

    let mut rows: Vec<ChoiceScore> = Vec::with_capacity(candidates.len());
    for (i, c) in candidates.iter().enumerate() {
        if c.tokens.is_empty() {
            rows.push(ChoiceScore {
                index: i,
                rank: 0,
                choice: c.text.to_string(),
                perplexity: f32::INFINITY,
            });
            continue;
        }
        scorer.restore(&snap)?;
        let mut score = mean_nll(scorer, &first_logits, c.tokens)?;
        if calibrate {
            score += calibrate_term(scorer, c.tokens)?;
        }
        rows.push(ChoiceScore {
            index: i,
            rank: 0,
            choice: c.text.to_string(),
            perplexity: score,
        });
    }
    // 升序；同分按输入顺序（稳定 + 可预测的对拍）。
    rows.sort_by(|a, b| {
        a.perplexity
            .partial_cmp(&b.perplexity)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.index.cmp(&b.index))
    });
    for (rank, row) in rows.iter_mut().enumerate() {
        row.rank = rank;
    }
    Ok(rows)
}

/// 便捷入口：直接用 `GpuModel` + `State` 打分（内部套一层 [`ModelScorer`]）。
pub fn score_candidates_on_model(
    model: &mut GpuModel,
    state: &mut State,
    prompt: &[u32],
    candidates: &[Candidate],
    calibrate: bool,
) -> Result<Vec<ChoiceScore>, String> {
    let mut scorer = ModelScorer::new(model, state);
    score_candidates(&mut scorer, prompt, candidates, calibrate)
}

#[cfg(test)]
// 测试模块按 client/AGENTS.md 允许 unwrap（断言目标本身就是 Result）。
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// 无 GPU 的伪打分器：按调用顺序吐出 `script` 里的 logits（越界取最后一个）。
    /// `snapshot`/`restore` 搬运游标，正好把「每个候选从 prompt 末端快照起跑」这条
    /// 口径也测到；`ops` 记录调用序列，用来钉住「入口先 reset」这条口径。
    struct Scripted {
        script: Vec<Vec<f32>>,
        cursor: usize,
        resets: usize,
        ops: Vec<&'static str>,
    }

    impl Scripted {
        fn new(script: Vec<Vec<f32>>) -> Self {
            Self {
                script,
                cursor: 0,
                resets: 0,
                ops: Vec::new(),
            }
        }
        fn take(&mut self) -> Vec<f32> {
            let i = self.cursor.min(self.script.len() - 1);
            self.cursor += 1;
            self.script[i].clone()
        }
    }

    impl TokenScorer for Scripted {
        fn prefill(&mut self, _prompt: &[u32]) -> Result<Vec<f32>, String> {
            self.ops.push("prefill");
            self.cursor = 0;
            Ok(self.take())
        }
        fn step(&mut self, _tokens: &[u32]) -> Result<Vec<f32>, String> {
            self.ops.push("step");
            Ok(self.take())
        }
        fn snapshot(&mut self) -> Result<Vec<f32>, String> {
            self.ops.push("snapshot");
            Ok(vec![self.cursor as f32])
        }
        fn restore(&mut self, snap: &[f32]) -> Result<(), String> {
            self.ops.push("restore");
            self.cursor = snap[0] as usize;
            Ok(())
        }
        fn reset(&mut self) -> Result<(), String> {
            self.ops.push("reset");
            self.resets += 1;
            self.cursor = 0;
            Ok(())
        }
    }

    fn cand<'a>(text: &'a str, tokens: &'a [u32]) -> Candidate<'a> {
        Candidate { text, tokens }
    }

    #[test]
    fn log_prob_matches_hand_computation() {
        // logits [1,2,3]：max=3，Σexp(x-max)=e^-2+e^-1+1=1.5032147，ln=0.4076058
        // ln p(tok=1) = (2-3) - 0.4076058 = -1.4076058
        let lp = log_prob(&[1.0, 2.0, 3.0], 1).unwrap();
        assert!((lp - -1.407_606_0).abs() < 1e-5, "got {lp}");
        // 越界必须报错，而不是静默读越 vocab（宿主 vocab 与 logits 不一致的历史坑）
        assert!(log_prob(&[1.0, 2.0], 2).is_err());
        assert!(log_prob(&[], 0).is_err());
    }

    #[test]
    fn mean_nll_is_average_of_step_logprobs() {
        // 两步各得 -1.0 与 -3.0 → 平均 NLL = 2.0
        let mut s = Scripted::new(vec![
            vec![0.0, 1.0], // p(tok=1) 由 prefill 给出
            vec![2.0, 0.0], // step 后 tok=1 的概率由 [2,0] 给出
        ]);
        let first = s.prefill(&[7]).unwrap();
        let nll = mean_nll(&mut s, &first, &[1, 1]).unwrap();
        let manual = -(log_prob(&first, 1).unwrap() + log_prob(&[2.0, 0.0], 1).unwrap()) / 2.0;
        assert!(
            (nll as f64 - manual).abs() < 1e-6,
            "got {nll} want {manual}"
        );
    }

    #[test]
    fn empty_candidate_scores_infinity_and_is_skipped() {
        let mut s = Scripted::new(vec![vec![0.0; 4]]);
        let rows =
            score_candidates(&mut s, &[1, 2], &[cand("", &[]), cand("x", &[3])], false).unwrap();
        // 升序 → 有限分在前，+inf 在后；index 仍可回溯
        assert!(rows[0].perplexity.is_finite());
        assert_eq!(rows[0].index, 1);
        assert!(rows[1].perplexity.is_infinite());
        assert_eq!(rows[1].index, 0);
    }

    #[test]
    fn candidates_each_start_from_the_prompt_snapshot() {
        // 两个等长同 token 的候选必须得到**完全相同**的分数——若第二个候选没回灌快照
        // （状态被第一个候选推进过），分数就会不同。
        let mut s = Scripted::new(vec![
            vec![3.0, 0.0],
            vec![0.0, 3.0],
            vec![1.0, 1.0],
            vec![5.0, -5.0],
        ]);
        let rows = score_candidates(
            &mut s,
            &[9],
            &[cand("a", &[0, 1]), cand("b", &[0, 1])],
            false,
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        // 升序后同分 → 按 index 稳定排列
        assert_eq!(rows[0].index, 0);
        assert!((rows[0].perplexity - rows[1].perplexity).abs() < 1e-6);
    }

    #[test]
    fn calibrate_uses_l_plus_one_divisor_and_reduces_score() {
        // 单一 logits 全 0（V=2）→ 每步 ln p = -ln 2 = -0.693147
        // 条件平均 NLL（L=2）= 0.693147
        // calibrate（★ 参照口径）：tokens = [0] ++ c，但 Σ **只累加候选自身的 L 个**
        //   ln p（那个前置 0 只用来把状态从净零推进一格，`index` 从 1 起，不进分子），
        //   除数却是 **L+1 = 3** → 该项 = -(2·0.693147)/3 = -0.462098
        // 最终分 = 0.693147 - 0.462098 = 0.231049。若除数误用 L 会得 0.0 —— 正是这条
        // 断言把 quirk 钉住。
        let flat = || vec![0.0f32, 0.0];
        let mut s = Scripted::new(vec![flat(), flat(), flat()]);
        let plain = score_candidates(&mut s, &[5], &[cand("ab", &[0, 1])], false)
            .unwrap()
            .remove(0)
            .perplexity;
        assert!((f64::from(plain) - 2.0f64.ln()).abs() < 1e-5, "got {plain}");

        let mut s2 = Scripted::new(vec![flat(), flat(), flat()]);
        let cal = score_candidates(&mut s2, &[5], &[cand("ab", &[0, 1])], true)
            .unwrap()
            .remove(0)
            .perplexity;
        assert!(
            (f64::from(cal) - 2.0f64.ln() / 3.0).abs() < 1e-5,
            "got {cal}（= ln2/3：ln2 − 2·ln2/3）"
        );
        assert!(s2.resets >= 1, "calibrate 必须先清零回零态");
    }

    #[test]
    fn ranking_is_ascending_by_score() {
        // 首 token 的分布已经能分出优劣：prompt 末位 logits 偏向 token 1
        // → 候选 "b"([1]) 的 NLL≈0 排首位，"a"([0]) 的 NLL≈10 排第二；index 仍可回溯
        let mut s = Scripted::new(vec![vec![0.0, 10.0]]);
        let rows =
            score_candidates(&mut s, &[1], &[cand("a", &[0]), cand("b", &[1])], false).unwrap();
        assert_eq!(rows[0].index, 1, "更优候选应排首位: {rows:?}");
        assert!(rows[0].perplexity < rows[1].perplexity);
        assert_eq!(rows[1].index, 0);
        assert_eq!((rows[0].rank, rows[1].rank), (0, 1), "rank = 升序名次");

        // 同分（这里两个候选 token 完全相同）→ 保持输入顺序，对拍才可预测
        let mut s = Scripted::new(vec![vec![0.0, 10.0]]);
        let rows =
            score_candidates(&mut s, &[1], &[cand("b", &[1]), cand("b2", &[1])], false).unwrap();
        assert_eq!((rows[0].index, rows[1].index), (0, 1));
    }

    #[test]
    fn scoring_resets_state_before_prefill() {
        // 打分口径 = 「只看 prompt 的条件分布」，入口必须先 reset。少了这一脚，
        // 同一请求连打两次会因上一次留下的状态而给出不同分数
        // （mytown 实测：/v1/chooses 中文四城两次结果分数漂移且名次互换）。
        let mut s = Scripted::new(vec![vec![0.0, 1.0]]);
        score_candidates(&mut s, &[3], &[cand("a", &[0])], false).unwrap();
        assert_eq!(
            &s.ops[..2],
            &["reset", "prefill"],
            "入口先清零再灌 prompt: {:?}",
            s.ops
        );
        let once = s.ops.len();
        score_candidates(&mut s, &[3], &[cand("a", &[0])], false).unwrap();
        assert_eq!(
            &s.ops[once..once + 2],
            &["reset", "prefill"],
            "第二次同样从净零态起"
        );
    }

    #[test]
    fn empty_prompt_is_rejected() {
        let mut s = Scripted::new(vec![vec![0.0, 0.0]]);
        assert!(score_candidates(&mut s, &[], &[cand("a", &[1])], false).is_err());
    }
}
