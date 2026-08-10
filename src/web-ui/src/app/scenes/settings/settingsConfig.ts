import type { LucideIcon } from 'lucide-react';
import {
  Cpu,
  Mic,
  Hand,
  Settings2,
  Layers,
  MousePointerClick,
  MonitorSmartphone,
  Palette,
  Terminal,
  Volume2,
  User,
  Info,
} from 'lucide-react';

export type ConfigTab =
  | 'ui'
  | 'system'
  | 'voice-settings'
  | 'models'
  | 'voice'
  | 'gesture'
  | 'gesture-config'
  | 'gesture-templates'
  | 'gesture-actions'
  | 'click-effect'
  | 'smart-desktop'
  | 'account'
  | 'about'
  | 'basics';

export interface ConfigTabDef {
  id: ConfigTab;
  labelKey: string;
  descriptionKey?: string;
  keywords?: string[];
  beta?: boolean;
  icon: LucideIcon;
}

export interface ConfigCategoryDef {
  id: string;
  nameKey: string;
  tabs: ConfigTabDef[];
}

export const SETTINGS_CATEGORIES: ConfigCategoryDef[] = [
  {
    id: 'models',
    nameKey: 'configCenter.categories.models',
    tabs: [
      {
        id: 'models',
        labelKey: 'configCenter.tabs.taskModels',
        descriptionKey: 'configCenter.tabDescriptions.taskModels',
        icon: Cpu,
        keywords: [
          'api',
          'api key',
          'provider',
          'openai',
          'claude',
          'gpt',
          'base url',
          'proxy',
          'model',
          'temperature',
          'token',
        ],
      },
      {
        id: 'voice',
        labelKey: 'configCenter.tabs.voiceModels',
        descriptionKey: 'configCenter.tabDescriptions.voiceModels',
        icon: Mic,
        keywords: [
          'voice',
          'asr',
          'tts',
          'speech',
          'recognition',
          'synthesis',
          'engine',
          'init',
          'audio',
          'music',
          'sound',
          'mnn',
          'generation',
        ],
      },
    ],
  },
  {
    id: 'spells',
    nameKey: 'configCenter.categories.spells',
    tabs: [
      {
        id: 'gesture-config',
        labelKey: 'configCenter.tabs.gestureConfig',
        descriptionKey: 'configCenter.tabDescriptions.gestureConfig',
        icon: Hand,
        keywords: ['gesture', 'spell', 'enabled', 'grid', 'spacing', 'toggle', 'threshold'],
      },
      {
        id: 'gesture-templates',
        labelKey: 'configCenter.tabs.gestureTemplates',
        descriptionKey: 'configCenter.tabDescriptions.gestureTemplates',
        icon: Layers,
        keywords: ['gesture', 'spell', 'pattern', 'template', 'custom', 'record', 'draw', 'shape', 'circle', 'triangle', 'binding', 'action'],
      },
      {
        id: 'gesture-actions',
        labelKey: 'configCenter.tabs.gestureActions',
        descriptionKey: 'configCenter.tabDescriptions.gestureActions',
        icon: Settings2,
        keywords: ['gesture', 'spell', 'action', 'command', 'script', 'program', 'run'],
      },
    ],
  },
  {
    id: 'desktop-beautify',
    nameKey: 'configCenter.categories.desktopBeautify',
    tabs: [
      {
        id: 'click-effect',
        labelKey: 'configCenter.tabs.clickEffect',
        descriptionKey: 'configCenter.tabDescriptions.clickEffect',
        icon: MousePointerClick,
        keywords: ['click', 'effect', 'blessing', 'mouse', 'cursor', 'lucky'],
      },
      {
        id: 'smart-desktop',
        labelKey: 'configCenter.tabs.smartDesktop',
        descriptionKey: 'configCenter.tabDescriptions.smartDesktop',
        icon: MonitorSmartphone,
        keywords: ['desktop', 'underlay', 'wallpaper', 'replace', 'smart', 'grid', 'icon', 'pet'],
      },
    ],
  },
  {
    id: 'basic',
    nameKey: 'configCenter.categories.basic',
    tabs: [
      {
        id: 'ui',
        labelKey: 'configCenter.tabs.ui',
        descriptionKey: 'configCenter.tabDescriptions.ui',
        icon: Palette,
        keywords: [
          'language',
          'locale',
          'i18n',
          'theme',
          'appearance',
          'color',
          'accent',
          'font',
          'notification',
        ],
      },
      {
        id: 'system',
        labelKey: 'configCenter.tabs.system',
        descriptionKey: 'configCenter.tabDescriptions.system',
        icon: Terminal,
        keywords: [
          'logging',
          'log',
          'terminal',
          'shell',
          'pwsh',
          'powershell',
          'autostart',
          'login',
          'boot',
          'launch',
        ],
      },
      {
        id: 'voice-settings',
        labelKey: 'configCenter.tabs.voiceSettings',
        descriptionKey: 'configCenter.tabDescriptions.voiceSettings',
        icon: Volume2,
        keywords: [
          'voice',
          'audio',
          'microphone',
          'speaker',
          'mic',
          'input device',
          'output device',
          'voice input',
          'trigger',
          'charge',
          'recording',
        ],
      },
      {
        id: 'account',
        labelKey: 'configCenter.tabs.account',
        descriptionKey: 'configCenter.tabDescriptions.account',
        icon: User,
        keywords: [
          'account',
          'user',
          'username',
          'logout',
          'sign out',
        ],
      },
      {
        id: 'about',
        labelKey: 'configCenter.tabs.about',
        descriptionKey: 'configCenter.tabDescriptions.about',
        icon: Info,
        keywords: [
          'version',
          'update',
          'license',
          'about',
        ],
      },
    ],
  },
];

export const DEFAULT_SETTINGS_TAB: ConfigTab = 'ui';

const KNOWN_TABS: ConfigTab[] = SETTINGS_CATEGORIES.flatMap((c) => c.tabs.map((t) => t.id));

export function normalizeSettingsTab(section: string): ConfigTab {
  if (section === 'basics' || section === 'theme' || section === 'logging' || section === 'terminal' || section === 'system') return 'ui';
  if (section === 'lsp' || section === 'shortcuts' || section === 'keybindings' || section === 'hotkeys'
    || section === 'session-config' || section === 'ai-context' || section === 'mcp-tools' || section === 'editor'
    || section === 'keyboard') return DEFAULT_SETTINGS_TAB;
  if (section === 'vrm' || section === 'persona' || section === 'character' || section === 'assistant') return DEFAULT_SETTINGS_TAB;
  if ((KNOWN_TABS as readonly string[]).includes(section)) return section as ConfigTab;
  return DEFAULT_SETTINGS_TAB;
}
