import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { isAuthenticated, getToken } from "@/lib/auth";
import { authApi, type ProfileUpdateFields, type MemberProfileResponse } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { storage } from "@/lib/storage";
import { OnboardingPanel } from "@/pages/OnboardingPanel";
import { saveAvatarLocal, loadAvatarLocal } from "@/lib/avatar/avatarStorage";
import type { AvatarSelection } from "@/lib/avatar/config/avatar-config";

// Dev builds skip the (slow) model check; release builds always check so
// first-run users get ASR/TTS/RWKV models downloaded from the manifest
// (hf-mirror / modelscope first, huggingface as fallback).
const SKIP_MODEL_CHECK = import.meta.env.DEV;

// 将 MemberProfileResponse.member 转换为 OnboardingPanel 所需的 ProfileUpdateFields
function memberToProfileFields(m: MemberProfileResponse["member"]): ProfileUpdateFields {
  return {
    avatar_data: m.avatar_data ?? undefined,
    nickname: m.nickname ?? undefined,
    bio: m.bio ?? undefined,
    phone: m.phone ?? undefined,
    location: m.location ?? undefined,
    website: m.website ?? undefined,
    birthdate: m.birthdate ?? undefined,
    gender: m.gender ?? undefined,
  };
}

type StartupState = "booting" | "ready" | "failed";

interface ModelUpdateInfo {
  component: string;
  name: string;
  downloadUrl: string;
  url: string;
}

interface CheckResult {
  has_update: boolean;
  updates: ModelUpdateInfo[];
}

interface DownloadTask {
  task_id: string;
  status: string;
  progress: number;
  total: number;
  error?: string;
}

interface ResourceStatus {
  key: string;
  version: string;
  size: number;
  state: string;
}

interface ResourcesCheckResult {
  manifest_version: string;
  statuses: ResourceStatus[];
  all_ok: boolean;
}

export function HomePage() {
  const navigate = useNavigate();
  const { t, locale, setLocale } = useI18n();
  const [downloadStatus, setDownloadStatus] = useState(t("initBooting"));
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [startupState, setStartupState] = useState<StartupState>("booting");
  const cancelledRef = useRef(false);
  const initialized = startupState === "ready";
  const initFailed = startupState === "failed";

  // Onboarding（每次启动都显示，编辑过则显示已编辑角色）
  const [initialProfile, setInitialProfile] = useState<ProfileUpdateFields | undefined>(undefined);
  const [savingProfile, setSavingProfile] = useState(false);
  const [saved, setSaved] = useState(false);
  const onboardingLoadedRef = useRef(false);

  // 进入主应用：用户点击"进入"后触发
  const [entering, setEntering] = useState(false);
  const enteringRef = useRef(false);
  const overlayOpenedRef = useRef(false);

  // editMode：已设置过形象（avatar_data 有效）或已保存等待初始化时为 true，隐藏资料填写和配件选择
  const editMode = useMemo(() => {
    if (saved) return true;
    if (!initialProfile?.avatar_data) return false;
    try {
      const parsed = JSON.parse(initialProfile.avatar_data);
      return !!(parsed && typeof parsed.parts === 'object' && typeof parsed.colors === 'object');
    } catch {
      return false;
    }
  }, [initialProfile?.avatar_data, saved]);

  // 进度信息（传给 OnboardingPanel 显示在形象预览下方）
  const progressInfo = useMemo(
    () => ({
      status: downloadStatus,
      progress: downloadProgress,
      initialized,
      failed: initFailed,
    }),
    [downloadStatus, downloadProgress, initialized, initFailed],
  );

  const handleComplete = async (fields: ProfileUpdateFields) => {
    try {
      setSavingProfile(true);
      const token = await getToken();
      if (!token) {
        console.warn("[HomePage] handleComplete: no token");
        return;
      }
      await authApi.updateMemberProfile(token, fields);
      // 保存成功后切换到 editMode（隐藏表单和配件，保留形象 + 进度），
      // 一直显示直到窗口通过 'close-loader' 事件关闭
      setSaved(true);
    } catch (e) {
      console.error("[HomePage] updateMemberProfile failed:", e);
    } finally {
      // 无论服务端成功失败，都本地持久化 avatar（服务端不可达时降级）
      if (fields.avatar_data) {
        try {
          const avatar = JSON.parse(fields.avatar_data) as AvatarSelection;
          await saveAvatarLocal(avatar);
        } catch (e) {
          console.warn("[HomePage] saveAvatarLocal failed:", e);
        }
      }
      setSavingProfile(false);
    }
  };

  // 用户点击"进入"按钮
  const handleEnter = useCallback(() => {
    if (enteringRef.current || overlayOpenedRef.current) return;
    enteringRef.current = true;
    setEntering(true);
  }, []);

  // 自动进入：用户已有形象(editMode) + 初始化完成 + 未失败 + 未在进入中 → 自动触发进入
  // 避免用户每次都要手动点"进入"按钮
  useEffect(() => {
    if (!editMode || !initialized || initFailed) return;
    if (enteringRef.current || overlayOpenedRef.current) return;
    handleEnter();
  }, [editMode, initialized, initFailed, handleEnter]);

  // 监听 entering + initialized：用户已点击进入 且 系统初始化完成 → 打开主窗口
  useEffect(() => {
    if (!entering) return;
    if (!initialized) return;
    if (overlayOpenedRef.current) return;
    overlayOpenedRef.current = true;

    let cancelled = false;
    const openMainAndListen = async () => {
      try {
        await invoke("open_overlay_force");
      } catch (e) {
        console.warn("[HomePage] open_overlay_force failed:", e);
      }
      if (cancelled) return;

      try {
        const unlisten = await listen('close-loader', async () => {
          unlisten();
          try {
            const currentWindow = await getCurrentWindow();
            await currentWindow.close();
          } catch {
            // ignore
          }
        });
      } catch {
        setTimeout(async () => {
          if (cancelled) return;
          try {
            const currentWindow = await getCurrentWindow();
            await currentWindow.close();
          } catch {
            // ignore
          }
        }, 5000);
      }
    };
    openMainAndListen();

    return () => { cancelled = true; };
  }, [entering, initialized]);

  useEffect(() => {
    cancelledRef.current = false;

    const runInit = async () => {
      try {
        // 总是先到登录页（除非本次会话已通过登录验证）
        // 这样已登录用户也会看到登录页的"免登录"入口，需要验证 token 后才能进入
        const loginPassed = (await storage.get('login_passed')) === '1';
        if (!loginPassed) {
          navigate("/login");
          return;
        }

        const authed = await isAuthenticated();
        if (!authed) {
          navigate("/login");
          return;
        }

        // 并行加载会员档案（用于 OnboardingPanel 回填），不阻塞主初始化流程
        if (!onboardingLoadedRef.current) {
          onboardingLoadedRef.current = true;

          // 先读本地 avatar 快速回填（网络拉取前，避免空白等待）
          const localAvatar = await loadAvatarLocal();
          if (localAvatar && !cancelledRef.current) {
            setInitialProfile((prev) => ({
              ...prev,
              avatar_data: JSON.stringify(localAvatar),
            }));
          }

          void (async () => {
            try {
              const token = await getToken();
              if (!token) return;
              const profile = await authApi.getMemberProfile(token);
              if (!cancelledRef.current) {
                setInitialProfile(memberToProfileFields(profile.member));
              }
            } catch (e) {
              console.warn("[HomePage] load member profile failed:", e);
            }
          })();
        }

        const cancelled = () => cancelledRef.current;

        const setStatus = (status: string) => {
          if (!cancelled()) setDownloadStatus(status);
        };

        const warnInit = (stageLabel: string, _error: unknown) => {
          if (!cancelled()) {
            console.warn(`[HomePage] ${stageLabel}: ${_error instanceof Error ? _error.message : String(_error)}`);
          }
        };

        // Step 0: Split-installer resources (main.zip / underlay.zip /
        // sounds.zip / runtime-*.zip). The installer ships only the exe +
        // loader.zip; everything else is fetched here on first run / update.
        // Non-fatal: offline machines with resources already in place keep
        // working (resources_check fails → skip).
        setStatus(t("homeResCheck"));
        try {
          const res = await invoke<ResourcesCheckResult>("resources_check");
          const pending = res.statuses.filter((s) => s.state !== "ok");
          for (const status of pending) {
            if (cancelled()) return;

            setStatus(`${t("homeResDownload")} ${status.key}...`);
            setDownloadProgress(0);

            // Poll progress while resources_download runs.
            const taskId = `resource-${status.key}`;
            let polling = true;
            const poll = (async () => {
              while (polling && !cancelled()) {
                try {
                  const p = await invoke<DownloadTask | null>(
                    "get_download_progress",
                    { taskId },
                  );
                  if (p && p.total > 0) {
                    setDownloadProgress(
                      Math.round((p.progress / p.total) * 100),
                    );
                  }
                } catch {
                  // task not visible yet — ignore
                }
                await new Promise((r) => setTimeout(r, 500));
              }
            })();

            try {
              await invoke("resources_download", { key: status.key });
            } catch (e) {
              warnInit(`${t("homeDownloadFailed")}: ${status.key}`, e);
            } finally {
              polling = false;
              await poll;
            }
          }
          if (!cancelled() && pending.length > 0) {
            setDownloadProgress(0);
          }
        } catch (e) {
          warnInit(t("homeResCheck"), e);
        }

        // Step 1: Check model updates
        if (SKIP_MODEL_CHECK) {
          console.log("[HomePage] dev mode: skip model check and download");
          setStatus(t("homeInitRuntime"));
        } else {
          setStatus(t("homeVersionCheck"));
          try {
            const result = await invoke<CheckResult>("check_model_updates");

            if (result && result.has_update && result.updates.length > 0) {
              setStatus(t("homeStartDownload"));

              for (const update of result.updates) {
                if (cancelled()) return;

                try {
                  const taskId = await invoke<string>("download_model", {
                    modelInfo: update,
                  });

                  let progress: DownloadTask | null = null;
                  while (
                    !cancelled() &&
                    (progress === null ||
                      progress.status === "Downloading" ||
                      progress.status === "Pending")
                  ) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    try {
                      progress = await invoke<DownloadTask | null>(
                        "get_download_progress",
                        { taskId }
                      );
                      if (progress && progress.total > 0) {
                        const pct = Math.round(
                          (progress.progress / progress.total) * 100
                        );
                        if (!cancelled()) setDownloadProgress(pct);
                        setStatus(
                          `${t("homeDownloadingModel")} ${update.name} ${pct}%`
                        );
                      }
                    } catch {
                      break;
                    }
                  }

                  if (progress && progress.status === "Failed") {
                    warnInit(
                      `${t("homeDownloadFailed")}: ${update.name}`,
                      new Error(progress.error || progress.status)
                    );
                  }
                } catch (e) {
                  warnInit(`${t("homeDownloadFailed")}: ${update.name}`, e);
                }
              }

              if (!cancelled()) {
                setDownloadProgress(0);
                setStatus(t("homeDownloadComplete"));
              }
            } else {
              if (!cancelled()) {
                setStatus(t("homeUpToDate"));
              }
            }
          } catch (e) {
            warnInit(t("homeVersionCheck"), e);
          }
        }

        // Step 2: Initialize runtimes (ONNX + Llama FFI)
        setStatus(t("homeInitRuntime"));
        try {
          await invoke("init_all_runtimes_cmd");
        } catch (e) {
          warnInit(t("homeInitRuntime"), e);
        }

        // Step 3: Get exe directory + models directory
        let exeDir = "";
        let modelsDir = "";
        try {
          exeDir = await invoke<string>("get_exe_dir_cmd");
        } catch (e) {
          warnInit(t("homeInitRuntime"), e);
        }
        try {
          // Respects AI00X_MODELS_DIR (dev → .ai00-x-dev/models), else exe_dir/models
          modelsDir = await invoke<string>("get_models_dir_cmd");
        } catch (e) {
          warnInit(t("homeInitRuntime"), e);
        }
        if (!modelsDir) {
          modelsDir = exeDir + "/models";
        }

        // Step 4: Initialize ASR engine
        setStatus(t("homeInitAsr"));
        try {
          await invoke("init_asr_engine", {
            modelDir: modelsDir + "/asr",
          });
        } catch (e) {
          warnInit(t("homeInitAsr"), e);
        }

        // Step 5: Start global voice input service (non-fatal)
        try {
          await invoke("start_global_voice_input_service");
        } catch (e) {
          warnInit("start_global_voice_input_service", e);
        }

        // Step 6: Initialize TTS engine
        setStatus(t("homeInitTts"));
        try {
          const modelDir = modelsDir + "/tts";
          console.log("[HomePage] TTS model directory:", modelDir);
          await invoke("init_tts_engine", {
            modelDir,
            quant: "q4km",
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[HomePage] TTS init failed:", msg);
          setDownloadStatus(`TTS 初始化失败: ${msg}`);
        }

        // Step 7: Initialize LLM engine
        setStatus(t("homeInitLlm"));
        let llm_init_done = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) {
            setDownloadStatus(
              `LLM 初始化失败，${5}秒后重试 (第${attempt + 1}次)...`,
            );
            await new Promise((r) => setTimeout(r, 5000));
            setStatus(t("homeInitLlm"));
          }
          try {
            await invoke("init_llm_engine", {
              modelPath: null,
              vocabPath: null,
            });
            llm_init_done = true;
            break;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error("[HomePage] LLM init failed (attempt", attempt + 1, "):", msg);
            if (attempt === 1) {
              setDownloadStatus(
                `LLM 初始化失败: ${msg}。请关闭其他 GPU 应用后重启程序`,
              );
            }
          }
        }
        if (!llm_init_done) {
          warnInit(t("homeInitLlm"), "LLM init failed after 2 attempts");
        }

        // Step 8: Initialize Embedding engine (non-fatal)
        setStatus(t("homeInitEmbedding"));
        try {
          await invoke("init_embedding_engine");
        } catch (e) {
          warnInit(t("homeInitEmbedding"), e);
        }

        // Step 9: Initialize Audio Gen engine (non-fatal)
        try {
          const gpuInfo = await invoke<{ cuda_available: boolean; vulkan_available: boolean; recommended_backend: number }>('detect_mnn_gpu');
          const mnnGpu = gpuInfo.recommended_backend;
          console.log(`[Audio Gen] GPU detect: cuda=${gpuInfo.cuda_available}, vulkan=${gpuInfo.vulkan_available}, using=${mnnGpu}`);
          await invoke("init_audio_gen_engine", {
            modelDir: modelsDir + "/sa3",
            variant: "sm-music",
            mnnGpu,
            mnnInt8: true,
            defaultDuration: 10.0,
          });
        } catch (e) {
          warnInit("Audio Gen", e);
        }

        // Step 10: 初始化完成（不在此处打开主窗口，由独立 useEffect 在
        // 初始化完成 + 个人信息已保存 两个条件都满足时才 open_overlay_force）
        if (!cancelled()) {
          setStatus(t("homeInitComplete"));
          setDownloadProgress(100);
          setStartupState("ready");
        }
      } catch {
        if (!cancelledRef.current) {
          // already handled by failInit
        }
      }
    };

    runInit();
    return () => {
      cancelledRef.current = true;
    };
  }, [navigate, t]);

  return (
    <div className="h-screen w-screen flex flex-col bg-transparent">
      <div
        className="flex-1 flex flex-col items-center justify-center relative overflow-hidden rounded-xl border shadow-2xl m-2"
        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--card-bg)' }}
      >
        {/* 统一页头：可拖拽 + 语言切换，始终在最上层 */}
        <div
          className="absolute top-0 left-0 right-0 h-10 z-[80] flex items-center justify-end px-4"
          data-tauri-drag-region
          style={{ backgroundColor: 'var(--card-bg)', borderBottom: '1px solid var(--border)' }}
        >
          <button
            type="button"
            onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
            className="btn-plain rounded-md px-2 py-1 text-xs font-medium"
            style={{ color: "var(--text-50)" }}
          >
            {locale === "zh" ? "EN" : "中"}
          </button>
        </div>

        {/* 主内容：从页头下方开始（top-10） */}
        <div className="absolute top-10 inset-x-0 bottom-0 z-[60] flex">
          <OnboardingPanel
            initialProfile={initialProfile}
            onComplete={handleComplete}
            saving={savingProfile}
            editMode={editMode}
            progressInfo={progressInfo}
            canEnter={editMode && initialized && !initFailed}
            entering={entering}
            onEnter={handleEnter}
          />
        </div>
      </div>
    </div>
  );
}
