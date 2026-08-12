#![allow(non_snake_case)]
//! Ai00-X Desktop - Tauri-based desktop application with TransportAdapter architecture

pub mod api;
pub mod asr;
pub mod audio_capture;
pub mod audio_gen;
pub mod audio_playback;
pub mod auth;
pub mod auth_vault;
pub mod computer_use;
pub mod desktop;
pub mod download_manager;
pub mod embedding;
pub mod kv_store;
pub mod logging;
pub mod machine_id;
pub mod macos_menubar;
pub mod memory_sidecar;
pub mod model_checker;
pub mod model_init;
pub mod overlay;
pub use ai00_x_inference::runtime;
pub mod chat_history_backup;
pub mod preview_window;
pub mod profile_sync;
pub mod rwkv_engine_adapter;
pub mod rwkv_llm;
pub mod server;
pub mod share;
pub mod system_monitor;
pub mod task_window;
pub mod theme;
pub mod tts;
pub mod underlay;
pub mod usage_stats;
pub mod zip_serve;

use ai00_x_core::agent::tools::computer_use_capability::set_computer_use_desktop_available;
use ai00_x_core::agent::tools::computer_use_host::ComputerUseHostRef;
use ai00_x_core::infrastructure::ai::AIClientFactory;
use ai00_x_core::infrastructure::app_paths::path_migration;
use ai00_x_core::infrastructure::{get_path_manager_arc, try_get_path_manager_arc};
use ai00_x_core::service::workspace::get_global_workspace_service;
use ai00_x_transport::{TauriTransportAdapter, TransportAdapter};
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::Manager;

// Re-export API
pub use api::*;

use api::acestep_api::*;
use api::ai_rules_api::*;
use api::clipboard_file_api::*;
use api::commands::*;
use api::computer_use_api::*;
use api::config_api::*;
use api::cron_api::*;
use api::diff_api::*;
use api::git_agent_api::*;
use api::git_api::*;
use api::i18n_api::*;
use api::lsp_api::*;
use api::lsp_workspace_api::*;
use api::mcp_api::*;
use api::runtime_api::*;
use api::session_api::*;
use api::skill_api::*;
use api::snapshot_service::*;
use api::startchat_agent_api::*;
use api::storage_commands::*;
use api::subagent_api::*;
use api::system_api::*;
use api::tool_api::*;
use api::usage_stats_api::*;

/// Agent Coordinator state
#[derive(Clone)]
pub struct CoordinatorState {
    pub coordinator: Arc<ai00_x_core::agent::coordination::ConversationCoordinator>,
}

/// Dialog scheduler state (primary entry point for user messages)
#[derive(Clone)]
pub struct SchedulerState {
    pub scheduler: Arc<ai00_x_core::agent::coordination::DialogScheduler>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebdriverBridgeResultRequest {
    payload: serde_json::Value,
}

#[tauri::command]
async fn webdriver_bridge_result(request: WebdriverBridgeResultRequest) -> Result<(), String> {
    log::debug!("webdriver_bridge_result command invoked");
    ai00_x_webdriver::handle_bridge_result(request.payload)
}

/// Tauri application entry point
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run() {
    let in_debug = cfg!(debug_assertions) || std::env::var("DEBUG").unwrap_or_default() == "1";
    let log_config = logging::LogConfig::new(in_debug);
    let log_targets = logging::build_log_targets(&log_config);
    let session_log_dir = log_config.session_log_dir.clone();

    // Verify shared GGML DLLs in runtime/gguf/ before any model/DLL is loaded.
    // Both llama.dll and acestep_c.dll load GGML from this single location.
    ai00_x_inference::runtime::sync_ggml_dlls();

    // Run legacy data migration before any module reads user paths.
    // Each migration is non-fatal — failures are logged and skipped.
    {
        let pm = get_path_manager_arc();
        log::info!("[startup] running legacy path migration...");
        path_migration::run_all_migrations(&pm).await;
    }

    if let Err(e) = ai00_x_core::service::config::initialize_global_config().await {
        eprintln!("[FATAL] Failed to initialize global config service: {}", e);
        return;
    }

    // Initialize global I18nService so bot/remote-connect language is always in sync.
    {
        use ai00_x_core::service::config::get_global_config_service;
        use ai00_x_core::service::i18n::initialize_global_i18n_service;
        match get_global_config_service() {
            Ok(config_service) => {
                if let Err(e) = initialize_global_i18n_service(Some(config_service)).await {
                    log::error!("Failed to initialize global I18nService: {}", e);
                }
            }
            Err(e) => {
                log::error!("Failed to get config service for I18nService init: {}", e);
            }
        }
    }

    // Ensure workspace directories exist (scratch, code, task).
    // Scratch workspace contents are cleared on every startup.
    if let Err(e) = ensure_workspace_dirs().await {
        log::error!("Failed to ensure workspace directories: {}", e);
    }

    let startup_log_level = resolve_runtime_log_level(log_config.level).await;

    if let Err(e) = AIClientFactory::initialize_global().await {
        eprintln!("[FATAL] Failed to initialize global AIClientFactory: {}", e);
        return;
    }

    ai00_x_ai_adapters::providers::rwkv::engine::register_rwkv_engine(std::sync::Arc::new(
        rwkv_engine_adapter::DesktopRwkvEngine,
    ));

    let (coordinator, scheduler, event_queue, event_router, ai_client_factory, token_usage_service) =
        match init_agent_system().await {
            Ok(state) => state,
            Err(e) => {
                eprintln!("[FATAL] Failed to initialize agent system: {}", e);
                return;
            }
        };

    if let Err(e) = init_function_agents(ai_client_factory.clone()).await {
        eprintln!("[FATAL] Failed to initialize function agents: {}", e);
        return;
    }

    let app_state = match AppState::new_async(token_usage_service).await {
        Ok(state) => state,
        Err(e) => {
            eprintln!("[FATAL] Failed to initialize AppState: {}", e);
            return;
        }
    };

    let coordinator_state = CoordinatorState {
        coordinator: coordinator.clone(),
    };

    let scheduler_state = SchedulerState {
        scheduler: scheduler.clone(),
    };

    let terminal_state = api::terminal_api::TerminalState::new();

    let path_manager = get_path_manager_arc();

    // Vault and UI prefs live under <exe_dir>/data/profile/ for portability:
    //   profile/auth_vault/   — login state (AES)
    //   profile/kv_vault/     — sensitive KV (AES)
    //   profile/ui_prefs.json — UI preferences (plaintext)
    auth_vault::init_user_auth_vault(path_manager.profile_dir().join("auth_vault"));
    kv_store::init_user_kv_vault(path_manager.profile_dir().join("kv_vault"));
    kv_store::init_ui_prefs(path_manager.profile_dir());

    setup_panic_hook();

    tauri::Builder::default()
        .plugin(logging::build_log_plugin(log_targets))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Ai00-X")
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .manage(coordinator_state)
        .manage(scheduler_state)
        .manage(path_manager)
        .manage(coordinator)
        .manage(scheduler)
        .manage(terminal_state)
        .manage(overlay::OverlayState::default())
        .manage(api::gesture_api::GestureState::default())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
                app.on_menu_event(|app, event| {
                    let event_name =
                        crate::macos_menubar::menu_event_name_for_id(event.id().as_ref());

                    if let Some(event_name) = event_name {
                        let _ = app.emit(event_name, ());
                    }
                });
            }

            logging::register_runtime_log_state(startup_log_level, session_log_dir.clone());

            // Register bundled mobile-web resource path for remote connect.
            // tauri.conf.json maps "../../mobile-web/dist" -> "mobile-web/dist",
            // so the primary candidate is "mobile-web/dist". Additional fallbacks
            // handle legacy or non-standard bundle layouts.
            {
                let candidates = ["mobile-web/dist", "mobile-web", "dist"];
                let mut found = false;
                for candidate in &candidates {
                    if let Ok(p) = app
                        .path()
                        .resolve(candidate, tauri::path::BaseDirectory::Resource)
                    {
                        if p.join("index.html").exists() {
                            log::info!("Found bundled mobile-web at: {}", p.display());
                            api::remote_connect_api::set_mobile_web_resource_path(p);
                            found = true;
                            break;
                        }
                    }
                }
                if !found {
                    // Last resort: scan the resource root for any index.html
                    if let Ok(res_dir) = app.path().resource_dir() {
                        for sub in &["mobile-web/dist", "mobile-web", "dist", ""] {
                            let p = if sub.is_empty() {
                                res_dir.clone()
                            } else {
                                res_dir.join(sub)
                            };
                            if p.join("index.html").exists() {
                                log::info!(
                                    "Found mobile-web via resource root scan: {}",
                                    p.display()
                                );
                                api::remote_connect_api::set_mobile_web_resource_path(p);
                                break;
                            }
                        }
                    }
                }
            }

            let app_handle = app.handle().clone();
            server::start_salvo_server();
            ai00_x_webdriver::maybe_start(app_handle.clone());
            system_monitor::spawn_system_monitor(app.handle().clone());

            #[cfg(target_os = "macos")]
            {
                let app_handle_for_menu = app.handle().clone();
                let app_state: tauri::State<'_, api::app_state::AppState> = app.state();
                let config_service = app_state.config_service.clone();
                let workspace_path = app_state.workspace_path.clone();
                let macos_edit_menu_mode = app_state.macos_edit_menu_mode.clone();

                tokio::spawn(async move {
                    let language = config_service
                        .get_config::<String>(Some("app.language"))
                        .await
                        .unwrap_or_else(|_| "zh-CN".to_string());

                    let has_workspace = workspace_path.read().await.is_some();
                    let mode = if has_workspace {
                        crate::macos_menubar::MenubarMode::Workspace
                    } else {
                        crate::macos_menubar::MenubarMode::Startup
                    };
                    let edit_mode = *macos_edit_menu_mode.read().await;

                    let _ = crate::macos_menubar::set_macos_menubar_with_mode(
                        &app_handle_for_menu,
                        &language,
                        mode,
                        edit_mode,
                    );
                });
            }

            let transport = Arc::new(TauriTransportAdapter::new(app_handle.clone()));

            start_event_loop_with_transport(event_queue, event_router, transport);

            // Eagerly initialize the remote connect service so previously
            // paired bots start listening immediately on app startup.
            api::remote_connect_api::init_on_startup();

            {
                let _terminal_state: tauri::State<'_, api::terminal_api::TerminalState> =
                    app.state();
                let terminal_state_inner = api::terminal_api::TerminalState::new();
                let app_handle_clone = app_handle.clone();
                tokio::spawn(async move {
                    api::terminal_api::start_terminal_event_loop(
                        terminal_state_inner,
                        app_handle_clone,
                    );
                });
            }

            init_mcp_servers(app_handle.clone());

            init_services(app_handle.clone(), startup_log_level);

            // Initialize usage statistics collector (Phase 1: foreground
            // tracking + SQLite storage only). Failure is non-fatal — the
            // application continues to run without usage stats.
            {
                use std::sync::Mutex as StdMutex;
                use std::sync::Arc as StdArc;

                type ShutdownHolder =
                    StdArc<StdMutex<Option<tokio::sync::broadcast::Sender<()>>>>;

                let shutdown_holder: ShutdownHolder = StdArc::new(StdMutex::new(None));
                let pm = ai00_x_core::infrastructure::get_path_manager_arc();
                let db_path = pm.user_data_dir().join("usage_stats.db");
                match usage_stats::storage::UsageStatsStore::open(&db_path) {
                    Ok(store) => {
                        // Clone a handle for the API commands. The collector
                        // gets its own clone; both share the same r2d2 pool.
                        let api_store = store.clone();
                        match usage_stats::collector::UsageStatsCollector::new(store) {
                            Ok(collector) => {
                                let collector = StdArc::new(collector);
                                let shutdown_tx = collector.shutdown_handle();
                                tokio::spawn(collector.clone().run());
                                shutdown_holder
                                    .lock()
                                    .expect("lock usage_stats shutdown_holder")
                                    .replace(shutdown_tx);
                                log::info!(
                                    "usage_stats: collector started (db_path={})",
                                    db_path.display()
                                );
                            }
                            Err(e) => {
                                log::warn!("usage_stats: collector init failed: {}", e)
                            }
                        }
                        // Manage the store for Tauri command access
                        // (read-only queries). Even if the collector failed
                        // to start, historical data is still viewable.
                        app.manage(api_store);
                    }
                    Err(e) => log::warn!(
                        "usage_stats: store open failed at {}: {}",
                        db_path.display(),
                        e
                    ),
                }
                app.manage::<ShutdownHolder>(shutdown_holder);
            }

            logging::spawn_log_cleanup_task();

            log::info!("Ai00-X Desktop started successfully");
            Ok(())
        })
        .on_window_event({
            static CLEANUP_DONE: AtomicBool = AtomicBool::new(false);

            move |window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let label = window.label();
                    if label == "overlay" {
                        if CLEANUP_DONE
                            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                        {
                            log::info!("Overlay window close requested, cleaning up");
                            shutdown_usage_stats(window.app_handle());
                            underlay::cleanup(window.app_handle());
                            if let Some(win) = window.app_handle().get_webview_window("underlays") {
                                let _ = win.close();
                            }
                            task_window::close_all_task_windows(window.app_handle());
                            preview_window::close_all_preview_windows(window.app_handle());
                            ai00_x_core::util::process_manager::cleanup_all_processes();
                            api::remote_connect_api::cleanup_on_exit();

                            window.app_handle().exit(0);
                        } else {
                            api.prevent_close();
                        }
                    } else if label == "loader" {
                        let overlay_exists = window
                            .app_handle()
                            .get_webview_window("overlay")
                            .is_some();
                        if overlay_exists {
                            log::info!("Loader window close requested, overlay window exists, closing loader only");
                        } else if CLEANUP_DONE
                            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                        {
                            log::info!("Loader window close requested, no overlay window, cleaning up");
                            shutdown_usage_stats(window.app_handle());
                            underlay::cleanup(window.app_handle());
                            if let Some(win) = window.app_handle().get_webview_window("underlays") {
                                let _ = win.close();
                            }
                            task_window::close_all_task_windows(window.app_handle());
                            preview_window::close_all_preview_windows(window.app_handle());
                            ai00_x_core::util::process_manager::cleanup_all_processes();
                            api::remote_connect_api::cleanup_on_exit();

                            window.app_handle().exit(0);
                        } else {
                            api.prevent_close();
                        }
                    } else if label == "task-window" {
                        log::info!("Task window close requested, closing task window only");
                    } else if label == "preview" {
                        log::info!("Preview window close requested, closing window only");
                    } else if label == "underlays" {
                        log::info!("Underlay window close requested, ignoring");
                        api.prevent_close();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            theme::open_overlay_force,
            theme::show_main_window,
            theme::hide_loader_window,
            task_window::open_task_window,
            task_window::close_task_window,
            task_window::focus_task_window,
            task_window::is_task_window_open,
            preview_window::open_preview_window,
            preview_window::close_preview_window,
            preview_window::focus_preview_window,
            preview_window::is_preview_window_open,
            overlay::set_no_penetrate_regions,
            overlay::init_overlay,
            underlay::open_underlay_force,
            underlay::close_underlay,
            underlay::is_underlay_open,
            api::underlay_api::get_desktop_items,
            api::underlay_api::set_desktop_icons_visible,
            api::underlay_api::get_monitors,
            api::wallpaper_api::get_wallpaper_server_info,
            api::wallpaper_api::preview_wallpaper,
            api::wallpaper_api::create_project,
            api::wallpaper_api::list_projects,
            api::wallpaper_api::delete_project,
            api::wallpaper_api::export_project_zip,
            api::wallpaper_api::generate_wallpaper_project_name,
            api::wallpaper_api::create_workspace_wallpaper_project,
            api::wallpaper_api::list_workspace_wallpaper_projects,
            api::wallpaper_api::publish_wallpaper_project,
            api::wallpaper_api::delete_workspace_wallpaper_project,
            api::wallpaper_api::apply_wallpaper_to_desktop,
            api::wallpaper_api::compact_wallpaper_context,
            api::gesture_api::start_gesture_detection,
            api::gesture_api::stop_gesture_detection,
            api::gesture_api::get_gesture_config,
            api::gesture_api::set_gesture_config,
            api::gesture_api::add_gesture_template,
            api::gesture_api::remove_gesture_template,
            api::gesture_api::set_gesture_bindings,
            api::gesture_api::match_pattern,
            api::gesture_api::cancel_pattern,
            api::gesture_api::execute_custom_command,
            api::gesture_api::add_saved_action,
            api::gesture_api::remove_saved_action,
            api::gesture_api::update_saved_action,
            api::voice_api::start_global_voice_input_service,
            api::voice_api::stop_global_voice_input_service,
            api::voice_api::get_global_voice_input_status,
            api::voice_api::get_audio_input_devices,
            api::voice_api::get_audio_output_devices,
            auth::set_auth_info,
            auth::set_auth_info_pair,
            auth::get_auth_info,
            auth::refresh_auth_token,
            auth::clear_auth_info,
            auth::is_authenticated,
            auth::restore_auth_from_vault,
            auth::fetch_user_tier,
            machine_id::get_machine_id,
            machine_id::get_device_name,
            profile_sync::sync_profile_upload,
            profile_sync::sync_profile_download,
            profile_sync::sync_profile_clear_local,
            chat_history_backup::chat_history_export,
            chat_history_backup::chat_history_import,
            kv_store::vault_get,
            kv_store::vault_set,
            kv_store::vault_remove,
            kv_store::pref_get,
            kv_store::pref_set,
            kv_store::pref_remove,
            model_init::get_exe_dir_cmd,
            model_init::get_models_dir_cmd,
            model_init::get_runtime_dir_cmd,
            model_init::check_model_updates,
            model_init::download_model,
            model_init::get_download_progress,
            model_init::init_all_runtimes_cmd,
            model_init::get_engine_init_status,
            model_init::init_asr_engine,
            model_init::init_tts_engine,
            model_init::reinit_asr_engine,
            model_init::reinit_tts_engine,
            model_init::init_audio_gen_engine,
            model_init::reinit_audio_gen_engine,
            model_init::generate_audio,
            model_init::get_audio_gen_status,
            model_init::check_audio_gen_models,
            model_init::detect_mnn_gpu,
            model_init::get_speakers,
            model_init::delete_speaker,
            model_init::update_speaker_meta,
            model_init::tts_queue_start,
            model_init::tts_queue_push,
            model_init::tts_queue_stop,
            model_init::tts_preview,
            model_init::init_llm_engine,
            model_init::init_embedding_engine,
            crate::rwkv_llm::rwkv_init_webrwkv,
            crate::rwkv_llm::rwkv_chat,
            crate::rwkv_llm::rwkv_chat_stream,
            crate::rwkv_llm::rwkv_chat_stream_cancel,
            crate::rwkv_llm::rwkv_clear_session_cache,
            crate::rwkv_llm::rwkv_get_default_paths,
            api::agent_api::create_session,
            api::agent_api::cancel_session_creation,
            api::agent_api::update_session_model,
            api::agent_api::update_session_title,
            api::agent_api::ensure_coordinator_session,
            api::agent_api::start_dialog_turn,
            api::agent_api::compact_session,
            api::agent_api::cancel_dialog_turn,
            api::agent_api::delete_session,
            api::agent_api::restore_session,
            webdriver_bridge_result,
            api::agent_api::list_sessions,
            api::agent_api::confirm_tool_execution,
            api::agent_api::reject_tool_execution,
            api::agent_api::confirm_plan,
            api::agent_api::reject_plan,
            api::agent_api::revise_plan,
            api::agent_api::auto_review_plan,
            api::agent_api::cancel_tool,
            api::agent_api::generate_session_title,
            api::agent_api::get_available_modes,
            api::agent_api::submit_rating,
            api::agent_api::archive_and_merge,
            api::btw_api::btw_ask,
            api::btw_api::btw_ask_stream,
            api::btw_api::btw_cancel,
            api::editor_ai_api::editor_ai_stream,
            api::editor_ai_api::editor_ai_cancel,
            api::context_upload_api::upload_image_contexts,
            get_all_tools_info,
            get_readonly_tools_info,
            get_tool_info,
            validate_tool_input,
            execute_tool,
            is_tool_enabled,
            submit_user_answers,
            initialize_global_state,
            get_available_tools,
            report_ide_control_result,
            get_health_status,
            get_statistics,
            test_ai_connection,
            test_ai_config_connection,
            list_ai_models_by_config,
            initialize_ai,
            set_agent_model,
            get_agent_models,
            refresh_model_client,
            fix_mermaid_code,
            get_app_state,
            update_app_status,
            read_file_content,
            write_file_content,
            check_path_exists,
            get_file_metadata,
            get_file_editor_sync_hash,
            rename_file,
            export_local_file_to_path,
            reveal_in_explorer,
            get_file_tree,
            explorer_get_file_tree,
            get_directory_children,
            explorer_get_children,
            get_directory_children_paginated,
            explorer_get_children_paginated,
            search_files,
            search_filenames,
            search_file_contents,
            start_search_filenames_stream,
            start_search_file_contents_stream,
            cancel_search,
            delete_file,
            delete_directory,
            create_file,
            create_directory,
            list_directory_files,
            start_file_watch,
            stop_file_watch,
            get_watched_paths,
            get_clipboard_files,
            paste_files,
            get_config,
            api::config_api::get_ai00_s_base_url,
            api::config_api::get_assets_base_url,
            computer_use_get_status,
            computer_use_request_permissions,
            computer_use_open_system_settings,
            set_config,
            reset_config,
            export_config,
            import_config,
            validate_config,
            reload_config,
            sync_config_to_global,
            get_global_config_health,
            get_runtime_logging_info,
            get_runtime_capabilities,
            acestep_get_status,
            acestep_list_local_models,
            acestep_load_synth,
            acestep_load_lm,
            acestep_unload,
            acestep_generate,
            acestep_cancel,
            acestep_llm_complete,
            acestep_llm_chat_stream,
            acestep_web_search,
            acestep_align_lyrics,
            asr_api::asr_inspect_gguf,
            asr_api::asr_download_aligner,
            asr_api::asr_get_aligner_status,
            asr_api::asr_poll_aligner_progress,
            acestep_list_catalog,
            acestep_download_model,
            acestep_download_all_recommended,
            acestep_get_download_progress,
            acestep_test_mirrors,
            acestep_get_gpu_info,
            acestep_get_presets,
            acestep_download_preset,
            acestep_session_list,
            acestep_session_load,
            acestep_session_save,
            acestep_session_delete,
            acestep_package_song,
            acestep_unpack_song,
            acestep_read_song_meta,
            acestep_read_song_meta_with_password,
            acestep_is_archive_encrypted,
            acestep_get_songs_dir,
            acestep_list_songs,
            acestep_delete_song,
            acestep_extract_cover,
            acestep_score_song,
            acestep_read_chunk_index,
            acestep_decrypt_block_range,
            acestep_update_song_meta,
            get_mode_configs,
            get_mode_config,
            set_mode_config,
            reset_mode_config,
            get_subagent_configs,
            set_subagent_config,
            list_subagents,
            get_subagent_detail,
            delete_subagent,
            create_subagent,
            update_subagent,
            reload_subagents,
            list_agent_tool_names,
            update_subagent_config,
            get_skill_configs,
            list_skill_market,
            search_skill_market,
            download_skill_market,
            validate_skill_path,
            add_skill,
            delete_skill,
            git_is_repository,
            git_get_repository,
            git_get_status,
            git_get_branches,
            git_get_enhanced_branches,
            git_get_commits,
            git_add_files,
            git_commit,
            git_push,
            git_pull,
            git_checkout_branch,
            git_create_branch,
            git_delete_branch,
            git_get_diff,
            git_reset_files,
            git_reset_to_commit,
            git_get_file_content,
            git_get_graph,
            git_cherry_pick,
            git_cherry_pick_abort,
            git_cherry_pick_continue,
            git_list_worktrees,
            git_add_worktree,
            git_remove_worktree,
            git_merge_branch,
            git_has_conflicts,
            git_abort_merge,
            generate_commit_message,
            quick_commit_message,
            save_git_repo_history,
            load_git_repo_history,
            preview_commit_message,
            analyze_work_state,
            quick_analyze_work_state,
            generate_greeting_only,
            get_work_state_summary,
            compute_diff,
            apply_patch,
            save_merged_diff_content,
            initialize_snapshot,
            record_file_change,
            rollback_session,
            rollback_to_turn,
            accept_session,
            accept_file,
            reject_file,
            get_session_files,
            get_session_turns,
            get_turn_files,
            get_file_diff,
            get_operation_diff,
            get_operation_summary,
            get_session_operations,
            accept_operation,
            reject_operation,
            get_session_stats,
            get_snapshot_system_stats,
            get_snapshot_sessions,
            check_git_isolation,
            get_file_change_history,
            get_all_modified_files,
            get_baseline_snapshot_diff,
            get_storage_paths,
            get_project_storage_paths,
            cleanup_storage,
            cleanup_storage_with_policy,
            get_storage_statistics,
            initialize_project_storage,
            get_ai_rules,
            get_ai_rule,
            create_ai_rule,
            update_ai_rule,
            delete_ai_rule,
            get_ai_rules_stats,
            build_ai_rules_system_prompt,
            reload_ai_rules,
            toggle_ai_rule,
            // Session persistence API
            list_persisted_sessions,
            load_session_turns,
            save_session_turn,
            save_session_metadata,
            export_session_transcript,
            delete_persisted_session,
            touch_session_activity,
            load_persisted_session_metadata,
            // AI Memory API
            api::ai_memory_api::get_all_memories,
            api::ai_memory_api::add_memory,
            api::ai_memory_api::update_memory,
            api::ai_memory_api::delete_memory,
            api::ai_memory_api::toggle_memory,
            api::project_context_api::get_document_statuses,
            api::project_context_api::toggle_document_enabled,
            api::project_context_api::create_context_document,
            api::project_context_api::generate_context_document,
            api::project_context_api::cancel_context_document_generation,
            api::project_context_api::get_project_context_config,
            api::project_context_api::save_project_context_config,
            api::project_context_api::create_project_category,
            api::project_context_api::delete_project_category,
            api::project_context_api::get_all_categories,
            api::project_context_api::import_project_document,
            api::project_context_api::delete_imported_document,
            api::project_context_api::toggle_imported_document_enabled,
            api::project_context_api::delete_context_document,
            initialize_mcp_servers,
            api::mcp_api::initialize_mcp_servers_non_destructive,
            get_mcp_servers,
            api::mcp_api::list_mcp_resources,
            api::mcp_api::read_mcp_resource,
            api::mcp_api::list_mcp_prompts,
            api::mcp_api::get_mcp_prompt,
            start_mcp_server,
            stop_mcp_server,
            restart_mcp_server,
            get_mcp_server_status,
            load_mcp_json_config,
            save_mcp_json_config,
            get_mcp_tool_ui_uri,
            fetch_mcp_app_resource,
            send_mcp_app_message,
            submit_mcp_interaction_response,
            update_mcp_remote_auth,
            clear_mcp_remote_auth,
            api::mcp_api::delete_mcp_server,
            api::mcp_api::start_mcp_remote_oauth,
            api::mcp_api::get_mcp_remote_oauth_session,
            api::mcp_api::cancel_mcp_remote_oauth,
            api::mcp_api::get_mcp_skill_info,
            api::mcp_api::get_mcp_tools_preview,
            api::mcp_api::set_mcp_skill_description,
            api::mcp_api::regenerate_mcp_skill,
            lsp_initialize,
            lsp_start_server_for_file,
            lsp_stop_server,
            lsp_stop_all_servers,
            lsp_did_open,
            lsp_did_change,
            lsp_did_save,
            lsp_did_close,
            lsp_get_completions,
            lsp_get_hover,
            lsp_goto_definition,
            lsp_find_references,
            lsp_format_document,
            lsp_install_plugin,
            lsp_uninstall_plugin,
            lsp_list_plugins,
            lsp_get_plugin,
            lsp_get_server_capabilities,
            lsp_get_supported_extensions,
            lsp_open_workspace,
            lsp_close_workspace,
            lsp_open_document,
            lsp_change_document,
            lsp_save_document,
            lsp_close_document,
            lsp_get_completions_workspace,
            lsp_get_hover_workspace,
            lsp_goto_definition_workspace,
            lsp_find_references_workspace,
            lsp_get_code_actions_workspace,
            lsp_format_document_workspace,
            lsp_get_inlay_hints_workspace,
            lsp_rename_workspace,
            lsp_get_document_highlight_workspace,
            lsp_get_document_symbols_workspace,
            lsp_get_semantic_tokens_workspace,
            lsp_get_semantic_tokens_range_workspace,
            lsp_get_server_state,
            lsp_get_all_server_states,
            lsp_stop_server_workspace,
            lsp_list_workspaces,
            lsp_detect_project,
            lsp_prestart_server,
            reload_global_config,
            get_global_config_status,
            subscribe_config_updates,
            get_model_configs,
            get_recent_workspaces,
            remove_recent_workspace,
            cleanup_invalid_workspaces,
            get_opened_workspaces,
            open_workspace,
            open_remote_workspace,
            close_workspace,
            set_active_workspace,
            reorder_opened_workspaces,
            get_current_workspace,
            is_task_workspace,
            get_task_workspace_path,
            get_code_workspace_path,
            scan_workspace_info,
            list_cron_jobs,
            create_cron_job,
            update_cron_job,
            delete_cron_job,
            api::config_api::canonicalize_mode_configs,
            api::terminal_api::terminal_get_shells,
            api::terminal_api::terminal_create,
            api::terminal_api::terminal_get,
            api::terminal_api::terminal_list,
            api::terminal_api::terminal_close,
            api::terminal_api::terminal_write,
            api::terminal_api::terminal_resize,
            api::terminal_api::terminal_signal,
            api::terminal_api::terminal_ack,
            api::terminal_api::terminal_execute,
            api::terminal_api::terminal_send_command,
            api::terminal_api::terminal_has_shell_integration,
            api::terminal_api::terminal_shutdown_all,
            api::terminal_api::terminal_get_history,
            get_system_info,
            send_system_notification,
            check_command_exists,
            check_commands_exist,
            run_system_command,
            set_macos_edit_menu_mode,
            i18n_get_current_language,
            i18n_set_language,
            i18n_get_supported_languages,
            i18n_get_config,
            i18n_set_config,
            // Remote Connect
            api::remote_connect_api::remote_connect_get_device_info,
            api::remote_connect_api::remote_connect_get_lan_ip,
            api::remote_connect_api::remote_connect_get_lan_network_info,
            api::remote_connect_api::remote_connect_get_methods,
            api::remote_connect_api::remote_connect_start,
            api::remote_connect_api::remote_connect_stop,
            api::remote_connect_api::remote_connect_stop_bot,
            api::remote_connect_api::remote_connect_status,
            api::remote_connect_api::remote_connect_get_form_state,
            api::remote_connect_api::remote_connect_set_form_state,
            api::remote_connect_api::remote_connect_configure_custom_server,
            api::remote_connect_api::remote_connect_configure_bot,
            api::remote_connect_api::remote_connect_weixin_qr_start,
            api::remote_connect_api::remote_connect_weixin_qr_poll,
            api::remote_connect_api::remote_connect_get_bot_verbose_mode,
            api::remote_connect_api::remote_connect_set_bot_verbose_mode,
            // MiniApp API
            api::miniapp_api::list_miniapps,
            api::miniapp_api::get_miniapp,
            api::miniapp_api::create_miniapp,
            api::miniapp_api::update_miniapp,
            api::miniapp_api::delete_miniapp,
            api::miniapp_api::get_miniapp_versions,
            api::miniapp_api::rollback_miniapp,
            api::miniapp_api::get_miniapp_storage,
            api::miniapp_api::set_miniapp_storage,
            api::miniapp_api::grant_miniapp_workspace,
            api::miniapp_api::grant_miniapp_path,
            api::miniapp_api::miniapp_runtime_status,
            api::miniapp_api::miniapp_worker_call,
            api::miniapp_api::miniapp_worker_stop,
            api::miniapp_api::miniapp_worker_list_running,
            api::miniapp_api::miniapp_install_deps,
            api::miniapp_api::miniapp_recompile,
            api::miniapp_api::miniapp_dialog_message,
            api::miniapp_api::miniapp_import_from_path,
            api::miniapp_api::miniapp_sync_from_fs,
            api::miniapp_api::miniapp_ai_complete,
            api::miniapp_api::miniapp_ai_chat,
            api::miniapp_api::miniapp_ai_cancel,
            api::miniapp_api::miniapp_ai_list_models,
            // Browser API (embedded webview)
            api::browser_api::browser_webview_eval,
            api::browser_api::browser_get_url,
            // Browser Control API (CDP-based user browser control)
            api::browser_control_api::browser_control_get_status,
            api::browser_control_api::browser_control_launch,
            api::browser_control_api::browser_control_create_launcher,
            api::browser_control_api::browser_control_daemon_status,
            api::self_control_api::submit_self_control_response,
            // Insights API
            api::insights_api::generate_insights,
            api::insights_api::get_latest_insights,
            api::insights_api::load_insights_report,
            api::insights_api::has_insights_data,
            api::insights_api::cancel_insights_generation,
            // SSH Remote API
            api::ssh_api::ssh_list_saved_connections,
            api::ssh_api::ssh_save_connection,
            api::ssh_api::ssh_delete_connection,
            api::ssh_api::ssh_has_stored_password,
            api::ssh_api::ssh_connect,
            api::ssh_api::ssh_disconnect,
            api::ssh_api::ssh_disconnect_all,
            api::ssh_api::ssh_is_connected,
            api::ssh_api::ssh_get_server_info,
            api::ssh_api::ssh_get_config,
            api::ssh_api::ssh_list_config_hosts,
            api::ssh_api::remote_read_file,
            api::ssh_api::remote_write_file,
            api::ssh_api::remote_exists,
            api::ssh_api::remote_read_dir,
            api::ssh_api::remote_get_tree,
            api::ssh_api::remote_create_dir,
            api::ssh_api::remote_remove,
            api::ssh_api::remote_rename,
            api::ssh_api::remote_download_to_local_path,
            api::ssh_api::remote_upload_from_local_path,
            api::ssh_api::remote_execute,
            api::ssh_api::remote_open_workspace,
            api::ssh_api::remote_close_workspace,
            api::ssh_api::remote_get_workspace_info,
            // Audio Playback API
            audio_playback::commands::init_audio_mixer,
            audio_playback::commands::init_sound_library,
            audio_playback::commands::audio_play_bgm,
            audio_playback::commands::audio_play_sfx,
            audio_playback::commands::audio_play_preview,
            audio_playback::commands::audio_stop_channel,
            audio_playback::commands::audio_stop_all_sfx,
            audio_playback::commands::audio_stop_preview,
            audio_playback::commands::audio_set_channel_volume,
            audio_playback::commands::audio_set_master_volume,
            audio_playback::commands::audio_get_master_volume,
            audio_playback::commands::audio_get_spectrum,
            audio_playback::commands::audio_pause_channel,
            audio_playback::commands::audio_resume_channel,
            audio_playback::commands::audio_seek_channel,
            audio_playback::commands::audio_list_channels,
            audio_playback::commands::sound_library_list,
            audio_playback::commands::sound_library_play,
            audio_playback::commands::sound_library_save,
            audio_playback::commands::sound_library_delete,
            audio_playback::commands::delete_audio_file,
            // Usage statistics commands (Phase 1: read queries + CRUD).
            usage_stats_day_summary,
            usage_stats_timeline,
            usage_stats_trends,
            usage_stats_top_apps,
            usage_stats_heatmap,
            usage_stats_list_app_rules,
            usage_stats_update_app_rule,
            usage_stats_delete_app_rule,
            usage_stats_list_categories,
            usage_stats_create_category,
            usage_stats_delete_category,
            usage_stats_update_category,
            // Phase E.1: 分享相关命令
            api::share_api::share_upload_archive,
            api::share_api::share_list_mine,
            api::share_api::share_get_meta,
            api::share_api::share_delete,
            // Phase E.2: 分享浏览/下载/播放/统计
            api::share_api::share_list_recent,
            api::share_api::share_get_recommendations,
            api::share_api::share_download_and_decrypt,
            // P2P 离线解密：本地 .a00m → audio.flac + lyrics.lrc
            api::share_api::share_extract_from_local,
            api::share_api::share_record_play,
            api::share_api::share_get_stats,
            api::share_api::share_get_cover,
            // Phase E.3: 评论系统
            api::share_api::share_list_comments,
            api::share_api::share_add_comment,
            api::share_api::share_edit_comment,
            api::share_api::share_delete_comment,
            // Stage 5.12: P2P 下载命令（v9 重构，替代 HTTP fallback）
            api::p2p_api::p2p_download_share,
            api::p2p_api::p2p_cancel_download,
            api::p2p_api::p2p_get_status,
            api::p2p_api::p2p_get_progress,
            api::p2p_api::p2p_list,
            api::p2p_api::p2p_remove,
            api::p2p_api::p2p_cache_stats,
            api::p2p_api::p2p_clear_cache,
        ])
        .run(tauri::generate_context!())
        .ok();
}

async fn init_agent_system() -> anyhow::Result<(
    Arc<ai00_x_core::agent::coordination::ConversationCoordinator>,
    Arc<ai00_x_core::agent::coordination::DialogScheduler>,
    Arc<ai00_x_core::agent::events::EventQueue>,
    Arc<ai00_x_core::agent::events::EventRouter>,
    Arc<AIClientFactory>,
    Arc<ai00_x_core::service::token_usage::TokenUsageService>,
)> {
    use ai00_x_core::agent::*;

    let ai_client_factory = AIClientFactory::get_global()?;

    let event_queue = Arc::new(events::EventQueue::new(Default::default()));
    let event_router = Arc::new(events::EventRouter::new());

    let path_manager = try_get_path_manager_arc()?;
    let persistence_manager = Arc::new(persistence::PersistenceManager::new(path_manager.clone())?);

    let context_store = Arc::new(session::SessionContextStore::new());
    let context_compressor = Arc::new(session::ContextCompressor::new(Default::default()));

    let session_manager = Arc::new(session::SessionManager::new(
        context_store,
        persistence_manager,
        Default::default(),
    ));

    let tool_registry = tools::registry::get_global_tool_registry();
    let tool_state_manager = Arc::new(tools::pipeline::ToolStateManager::new(event_queue.clone()));

    let computer_use_host: ComputerUseHostRef =
        Arc::new(computer_use::DesktopComputerUseHost::new());
    set_computer_use_desktop_available(true);

    let tool_pipeline = Arc::new(tools::pipeline::ToolPipeline::new(
        tool_registry,
        tool_state_manager,
        Some(computer_use_host),
    ));

    let stream_processor = Arc::new(execution::StreamProcessor::new(event_queue.clone()));
    let round_executor = Arc::new(execution::RoundExecutor::new(
        stream_processor,
        event_queue.clone(),
        tool_pipeline.clone(),
    ));
    let execution_engine = Arc::new(execution::ExecutionEngine::new(
        round_executor,
        event_queue.clone(),
        session_manager.clone(),
        context_compressor,
        Default::default(),
    ));

    let coordinator = Arc::new(coordination::ConversationCoordinator::new(
        session_manager.clone(),
        execution_engine,
        tool_pipeline,
        event_queue.clone(),
        event_router.clone(),
    ));

    coordination::ConversationCoordinator::set_global(coordinator.clone());

    // Initialize token usage service and register subscriber
    let token_usage_service = Arc::new(
        ai00_x_core::service::token_usage::TokenUsageService::new(path_manager.clone())
            .await
            .map_err(|e| anyhow::anyhow!("Failed to initialize token usage service: {}", e))?,
    );
    ai00_x_core::service::token_usage::set_global_token_usage_service(token_usage_service.clone());
    let token_usage_subscriber = Arc::new(
        ai00_x_core::service::token_usage::TokenUsageSubscriber::new(token_usage_service.clone()),
    );
    event_router.subscribe_internal("token_usage".to_string(), token_usage_subscriber);

    log::info!("Token usage service initialized and subscriber registered");

    // Create the DialogScheduler and wire up the outcome notification channel
    let scheduler =
        coordination::DialogScheduler::new(coordinator.clone(), session_manager.clone());
    coordinator.set_scheduler_notifier(scheduler.outcome_sender());
    coordinator.set_round_preempt_source(scheduler.preempt_monitor());
    coordination::set_global_scheduler(scheduler.clone());

    let cron_service =
        ai00_x_core::service::cron::CronService::new(path_manager.clone(), scheduler.clone())
            .await
            .map_err(|e| anyhow::anyhow!("Failed to initialize cron service: {}", e))?;
    ai00_x_core::service::cron::set_global_cron_service(cron_service.clone());
    let cron_subscriber = Arc::new(ai00_x_core::service::cron::CronEventSubscriber::new(
        cron_service.clone(),
    ));
    event_router.subscribe_internal("cron_jobs".to_string(), cron_subscriber);
    cron_service.start();

    log::info!("Cron service initialized and subscriber registered");
    log::info!("Agent system initialized");
    Ok((
        coordinator,
        scheduler,
        event_queue,
        event_router,
        ai_client_factory,
        token_usage_service,
    ))
}

async fn ensure_workspace_dirs() -> anyhow::Result<()> {
    use ai00_x_core::infrastructure::PathManager;
    use ai00_x_core::service::config::get_global_config_service;
    use ai00_x_core::service::config::GlobalConfig;

    let config_service = get_global_config_service()
        .map_err(|e| anyhow::anyhow!("Failed to get config service: {}", e))?;

    let config: GlobalConfig = config_service
        .get_config(None)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to get config: {}", e))?;

    PathManager::ensure_workspace_dirs(config.workspace.default_workspace_parent_dir.as_deref())
        .await
        .map_err(|e| anyhow::anyhow!("{}", e))
}

async fn init_function_agents(ai_client_factory: Arc<AIClientFactory>) -> anyhow::Result<()> {
    let _ = ai00_x_core::function_agents::git_func_agent::GitFunctionAgent::new(
        ai_client_factory.clone(),
    );

    let _ = ai00_x_core::function_agents::startchat_func_agent::StartchatFunctionAgent::new(
        ai_client_factory.clone(),
    );

    Ok(())
}

fn init_mcp_servers(app_handle: tauri::AppHandle) {
    tokio::spawn(async move {
        let _ = app_handle;
    });
}

/// Send shutdown signal to the usage-stats collector (if running) so it can
/// flush the in-flight segment + end the session before app exit. Safe to
/// call multiple times — the second call finds `None` and no-ops.
fn shutdown_usage_stats(app_handle: &tauri::AppHandle) {
    use std::sync::Arc as StdArc;
    use std::sync::Mutex as StdMutex;
    type ShutdownHolder = StdArc<StdMutex<Option<tokio::sync::broadcast::Sender<()>>>>;
    if let Some(holder) = app_handle.try_state::<ShutdownHolder>() {
        if let Some(tx) = holder.lock().ok().and_then(|mut guard| guard.take()) {
            let _ = tx.send(());
            log::debug!("usage_stats: shutdown signal sent");
        }
    }
}

fn setup_panic_hook() {
    std::panic::set_hook(Box::new(move |panic_info| {
        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());

        let message = panic_info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| {
                panic_info
                    .payload()
                    .downcast_ref::<String>()
                    .map(String::as_str)
            })
            .unwrap_or("unknown panic message");

        log::error!("Application panic at {}: {}", location, message);
        eprintln!("[PANIC] {}: {}", location, message);
        let _ = std::io::Write::flush(&mut std::io::stderr());

        // Known wry bug: WKWebView.URL() returns nil after navigating to an
        // invalid address, causing url_from_webview to panic on unwrap().
        // This is non-fatal — the webview is still alive — so we log and
        // continue instead of killing the process.
        // See: https://github.com/tauri-apps/wry/pull/1554
        if location.contains("wry") && location.contains("wkwebview") {
            log::warn!("Suppressed non-fatal wry/wkwebview panic, application continues");
            return;
        }

        if message.contains("WSAStartup") || message.contains("10093") || message.contains("hyper")
        {
            log::error!("Network-related crash detected, possible solutions:");
            log::error!("  1) Restart the application");
            log::error!("  2) Check Windows network service status");
            log::error!("  3) Run as administrator");
        }

        std::process::exit(1);
    }));
}

fn start_event_loop_with_transport(
    event_queue: Arc<ai00_x_core::agent::events::EventQueue>,
    event_router: Arc<ai00_x_core::agent::events::EventRouter>,
    transport: Arc<TauriTransportAdapter>,
) {
    tokio::spawn(async move {
        loop {
            event_queue.wait_for_events().await;
            loop {
                let batch = event_queue.dequeue_configured_batch().await;
                if batch.is_empty() {
                    break;
                }

                for envelope in batch {
                    // Route to internal subscribers (e.g. RemoteSessionStateTracker)
                    // sequentially so that text chunks are appended in order.
                    if let Err(e) = event_router.route(envelope.clone()).await {
                        log::warn!("Internal event routing failed: {:?}", e);
                    }

                    if let Err(e) = transport.emit_event("", envelope.event).await {
                        log::error!("Failed to emit event: {:?}", e);
                    }
                }
            }
        }
    });
}

fn init_services(app_handle: tauri::AppHandle, default_log_level: log::LevelFilter) {
    use ai00_x_core::{infrastructure, service};

    spawn_ingest_server_with_config_listener();
    spawn_runtime_log_level_listener(default_log_level);

    tokio::spawn(async move {
        let transport = Arc::new(TauriTransportAdapter::new(app_handle.clone()));
        let emitter = create_event_emitter(transport);

        service::snapshot::initialize_snapshot_event_emitter(emitter.clone());

        ai00_x_core::service::initialize_file_watch_service(emitter.clone());

        if let Err(e) = service::lsp::initialize_global_lsp_manager().await {
            log::error!("Failed to initialize LSP manager: {}", e);
        }

        let event_system = infrastructure::events::get_global_event_system();
        event_system.set_emitter(emitter).await;
    });
}

async fn resolve_runtime_log_level(default_level: log::LevelFilter) -> log::LevelFilter {
    use ai00_x_core::service::config::get_global_config_service;

    if let Ok(config_service) = get_global_config_service() {
        if let Ok(config_level) = config_service
            .get_config::<String>(Some("app.logging.level"))
            .await
        {
            if let Some(level) = logging::parse_log_level(&config_level) {
                return level;
            }
            log::warn!(
                "Invalid app.logging.level '{}', falling back to default={}",
                config_level,
                logging::level_to_str(default_level)
            );
        }
    }

    default_level
}

fn spawn_runtime_log_level_listener(default_level: log::LevelFilter) {
    use ai00_x_core::service::config::{subscribe_config_updates, ConfigUpdateEvent};

    tokio::spawn(async move {
        if let Some(mut receiver) = subscribe_config_updates() {
            loop {
                match receiver.recv().await {
                    Ok(ConfigUpdateEvent::LogLevelUpdated { new_level }) => {
                        if let Some(level) = logging::parse_log_level(&new_level) {
                            logging::apply_runtime_log_level(level, "config_update_event");
                        } else {
                            log::warn!(
                                "Received invalid log level from config update event: {}",
                                new_level
                            );
                        }
                    }
                    Ok(ConfigUpdateEvent::ConfigReloaded) => {
                        let level = resolve_runtime_log_level(default_level).await;
                        logging::apply_runtime_log_level(level, "config_reloaded");
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        log::warn!("Log-level listener channel closed, stopping listener");
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("Log-level listener lagged by {} messages", n);
                    }
                }
            }
        } else {
            log::warn!("Config update subscription unavailable for log-level listener");
        }
    });
}

fn create_event_emitter(
    transport: Arc<TauriTransportAdapter>,
) -> Arc<dyn ai00_x_core::infrastructure::events::EventEmitter> {
    use ai00_x_core::infrastructure::events::TransportEmitter;
    Arc::new(TransportEmitter::new(transport))
}

fn spawn_ingest_server_with_config_listener() {
    use ai00_x_core::infrastructure::debug_log::IngestServerManager;
    use ai00_x_core::service::config::{
        get_global_config_service, subscribe_config_updates, ConfigUpdateEvent,
    };

    tokio::spawn(async move {
        let initial_config = if let Ok(config_service) = get_global_config_service() {
            if let Ok(config) = config_service
                .get_config::<ai00_x_core::service::config::GlobalConfig>(None)
                .await
            {
                let debug_config = &config.ai.debug_mode_config;
                let workspace_path = get_global_workspace_service()
                    .and_then(|service| service.try_get_current_workspace_path())
                    .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

                Some(ai00_x_core::infrastructure::debug_log::IngestServerConfig::from_debug_mode_config(
                    debug_config.ingest_port,
                    workspace_path.join(&debug_config.log_path),
                ))
            } else {
                None
            }
        } else {
            None
        };

        let configured_port = if let Ok(config_service) = get_global_config_service() {
            if let Ok(config) = config_service
                .get_config::<ai00_x_core::service::config::GlobalConfig>(None)
                .await
            {
                Some(config.ai.debug_mode_config.ingest_port)
            } else {
                None
            }
        } else {
            None
        };

        let manager = IngestServerManager::global();
        if let Err(e) = manager.start(initial_config).await {
            log::error!("Failed to start Debug Log Ingest Server: {}", e);
        }

        let actual_port = manager.get_actual_port().await;
        if let Some(cfg_port) = configured_port {
            if actual_port != cfg_port {
                if let Ok(config_service) = get_global_config_service() {
                    if let Err(e) = config_service
                        .set_config("ai.debug_mode_config.ingest_port", actual_port)
                        .await
                    {
                        log::error!("Failed to sync actual port to config: {}", e);
                    } else {
                        log::info!(
                            "Ingest Server port synced: actual_port={}, config_port={}",
                            actual_port,
                            cfg_port
                        );
                    }
                }
            }
        }

        if let Some(mut receiver) = subscribe_config_updates() {
            loop {
                match receiver.recv().await {
                    Ok(ConfigUpdateEvent::DebugModeConfigUpdated {
                        new_port,
                        new_log_path,
                    }) => {
                        let workspace_path = get_global_workspace_service()
                            .and_then(|service| service.try_get_current_workspace_path())
                            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
                        let full_log_path = workspace_path.join(&new_log_path);

                        if let Err(e) = manager.update_port(new_port, full_log_path).await {
                            log::error!("Failed to update Ingest Server config: port={}, log_path={}, error={}", new_port, new_log_path, e);
                        }
                    }
                    Ok(ConfigUpdateEvent::ConfigReloaded) => {
                        if let Ok(config_service) = get_global_config_service() {
                            if let Ok(config) = config_service
                                .get_config::<ai00_x_core::service::config::GlobalConfig>(None)
                                .await
                            {
                                let debug_config = &config.ai.debug_mode_config;
                                let workspace_path = get_global_workspace_service()
                                    .and_then(|service| service.try_get_current_workspace_path())
                                    .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
                                let full_log_path = workspace_path.join(&debug_config.log_path);

                                if let Err(e) = manager
                                    .update_port(debug_config.ingest_port, full_log_path)
                                    .await
                                {
                                    log::error!("Failed to update Ingest Server after config reload: port={}, error={}", debug_config.ingest_port, e);
                                }
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        log::warn!("Config update channel closed, stopping listener");
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("Config update listener lagged by {} messages", n);
                    }
                }
            }
        }
    });
}

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
