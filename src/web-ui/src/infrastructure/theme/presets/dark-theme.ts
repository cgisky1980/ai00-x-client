 

import { ThemeConfig } from '../types';

export const Ai00XDarkTheme: ThemeConfig = {
  
  id: 'ai00-x-dark',
  name: 'Dark',
  type: 'dark',
  description: 'Default dark theme',
  author: 'Ai00-X Team',
  version: '2.1.0',
  
  
  colors: {
    background: {
      primary: '#0e0e14',
      secondary: '#1e1e2a',
      tertiary: '#2e2e3e',
      quaternary: '#36364a',
      elevated: '#42425a',
      workbench: '#0a0a0f',
      scene: '#242436',
      tooltip: 'rgba(66, 66, 90, 0.96)',
    },
    
    text: {
      primary: '#f8f8fa',
      secondary: '#d6d6dc',
      muted: '#b0b0b8',
      disabled: '#888892',
    },
    
    accent: {
      50: 'rgba(69, 170, 222, 0.04)',
      100: 'rgba(69, 170, 222, 0.08)',
      200: 'rgba(69, 170, 222, 0.15)',
      300: 'rgba(69, 170, 222, 0.25)',
      400: 'rgba(69, 170, 222, 0.4)',
      500: '#45aade',
      600: '#2591c4',
      700: 'rgba(37, 145, 196, 0.8)',
      800: 'rgba(37, 145, 196, 0.9)',
    },
    
    purple: {
      50: 'rgba(139, 92, 246, 0.04)',
      100: 'rgba(139, 92, 246, 0.08)',
      200: 'rgba(139, 92, 246, 0.15)',
      300: 'rgba(139, 92, 246, 0.25)',
      400: 'rgba(139, 92, 246, 0.4)',
      500: '#8b5cf6',
      600: '#7c3aed',
      700: 'rgba(124, 58, 237, 0.8)',
      800: 'rgba(124, 58, 237, 0.9)',
    },
    
    semantic: {
      success: '#34d399',
      successBg: 'rgba(52, 211, 153, 0.1)',
      successBorder: 'rgba(52, 211, 153, 0.3)',
      
      warning: '#f59e0b',
      warningBg: 'rgba(245, 158, 11, 0.1)',
      warningBorder: 'rgba(245, 158, 11, 0.3)',
      
      error: '#ef4444',
      errorBg: 'rgba(239, 68, 68, 0.1)',
      errorBorder: 'rgba(239, 68, 68, 0.3)',
      
      info: '#d0d0d6',
      infoBg: 'rgba(255, 255, 255, 0.12)',
      infoBorder: 'rgba(255, 255, 255, 0.32)',
      
      
      highlight: '#d6d6dc',
      highlightBg: 'rgba(255, 255, 255, 0.14)',
    },
    
    border: {
      subtle: 'rgba(255, 255, 255, 0.26)',
      base: 'rgba(255, 255, 255, 0.35)',
      medium: 'rgba(255, 255, 255, 0.46)',
      strong: 'rgba(255, 255, 255, 0.60)',
      prominent: 'rgba(255, 255, 255, 0.74)',
    },
    
    element: {
      subtle: 'rgba(255, 255, 255, 0.10)',
      soft: 'rgba(255, 255, 255, 0.14)',
      base: 'rgba(255, 255, 255, 0.19)',
      medium: 'rgba(255, 255, 255, 0.28)',
      strong: 'rgba(255, 255, 255, 0.36)',
      elevated: 'rgba(255, 255, 255, 0.23)',
    },
    
    git: {
      branch: '#a1a1aa',
      branchBg: 'rgba(255, 255, 255, 0.06)',
      changes: 'rgb(245, 158, 11)',
      changesBg: 'rgba(245, 158, 11, 0.1)',
      added: 'rgb(34, 197, 94)',
      addedBg: 'rgba(34, 197, 94, 0.1)',
      deleted: 'rgb(239, 68, 68)',
      deletedBg: 'rgba(239, 68, 68, 0.1)',
      staged: 'rgb(34, 197, 94)',
      stagedBg: 'rgba(34, 197, 94, 0.1)',
    },
    
    scrollbar: {
      thumb: 'rgba(255, 255, 255, 0.22)',
      thumbHover: 'rgba(255, 255, 255, 0.38)',
    },
    
    overlay: {
      overlay: 'rgba(0, 0, 0, 0.65)',
      modalOverlay: 'rgba(0, 0, 0, 0.78)',
    },
    
    cardBg: {
      default: 'rgba(255, 255, 255, 0.16)',
      elevated: 'rgba(255, 255, 255, 0.20)',
      subtle: 'rgba(255, 255, 255, 0.09)',
      hover: 'rgba(255, 255, 255, 0.24)',
      active: 'rgba(255, 255, 255, 0.32)',
      accent: 'rgba(152, 164, 255, 0.22)',
      accentHover: 'rgba(152, 164, 255, 0.32)',
      purple: 'rgba(139, 92, 246, 0.18)',
      purpleHover: 'rgba(139, 92, 246, 0.26)',
    },
  },
  
  
  effects: {
    shadow: {
      xs: '0 1px 2px rgba(0, 0, 0, 0.9)',
      sm: '0 2px 4px rgba(0, 0, 0, 0.8)',
      base: '0 4px 8px rgba(0, 0, 0, 0.7)',
      lg: '0 8px 16px rgba(0, 0, 0, 0.6)',
      xl: '0 12px 24px rgba(0, 0, 0, 0.5)',
      '2xl': '0 16px 32px rgba(0, 0, 0, 0.4)',
    },
    
    glow: {
      blue: '0 12px 32px rgba(96, 165, 250, 0.2), 0 6px 16px rgba(96, 165, 250, 0.12), 0 3px 8px rgba(0, 0, 0, 0.12)',
      purple: '0 12px 32px rgba(139, 92, 246, 0.22), 0 6px 16px rgba(124, 58, 237, 0.14), 0 3px 8px rgba(0, 0, 0, 0.12)',
      mixed: '0 12px 32px rgba(255, 255, 255, 0.06), 0 6px 16px rgba(139, 92, 246, 0.12), 0 3px 8px rgba(0, 0, 0, 0.12)',
    },
    
    blur: {
      subtle: 'blur(4px) saturate(1.05)',
      base: 'blur(8px) saturate(1.1)',
      medium: 'blur(12px) saturate(1.2)',
      strong: 'blur(16px) saturate(1.3) brightness(1.1)',
      intense: 'blur(20px) saturate(1.4) brightness(1.15)',
    },
    
    radius: {
      sm: '6px',
      base: '8px',
      lg: '12px',
      xl: '16px',
      '2xl': '20px',
      full: '9999px',
    },
    
    spacing: {
      1: '4px',
      2: '8px',
      3: '12px',
      4: '16px',
      5: '20px',
      6: '24px',
      8: '32px',
      10: '40px',
      12: '48px',
      16: '64px',
    },
    
    opacity: {
      disabled: 0.6,
      hover: 0.8,
      focus: 0.9,
      overlay: 0.4,
    },
  },
  
  
  motion: {
    duration: {
      instant: '0.1s',
      fast: '0.15s',
      base: '0.3s',
      slow: '0.6s',
      lazy: '1s',
    },
    
    easing: {
      standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
      decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
      accelerate: 'cubic-bezier(0.4, 0, 1, 1)',
      bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
      smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
    },
  },
  
  
  typography: {
    font: {
      sans: "'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'SF Pro Display', Roboto, sans-serif",
      mono: "'FiraCode', 'JetBrains Mono', 'SF Mono', 'Consolas', 'Liberation Mono', monospace",
    },
    
    weight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
    
    size: {
      xs: '12px',
      sm: '13px',
      base: '14px',
      lg: '15px',
      xl: '16px',
      '2xl': '18px',
      '3xl': '22px',
      '4xl': '26px',
      '5xl': '32px',
    },
    
    lineHeight: {
      tight: 1.2,
      base: 1.5,
      relaxed: 1.6,
    },
  },
  
  
  components: {
    
    windowControls: {
      minimize: {
        dot: 'rgba(255, 255, 255, 0.38)',
        dotShadow: '0 0 4px rgba(0, 0, 0, 0.35)',
        hoverBg: 'rgba(255, 255, 255, 0.1)',
        hoverColor: '#e4e4e4',
        hoverBorder: 'rgba(255, 255, 255, 0.16)',
        hoverShadow: '0 2px 8px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
      },
      maximize: {
        dot: 'rgba(255, 255, 255, 0.38)',
        dotShadow: '0 0 4px rgba(0, 0, 0, 0.35)',
        hoverBg: 'rgba(255, 255, 255, 0.1)',
        hoverColor: '#e4e4e4',
        hoverBorder: 'rgba(255, 255, 255, 0.16)',
        hoverShadow: '0 2px 8px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
      },
      close: {
        dot: 'rgba(239, 68, 68, 0.45)',
        dotShadow: '0 0 4px rgba(239, 68, 68, 0.2)',
        hoverBg: 'rgba(239, 68, 68, 0.12)',
        hoverColor: '#ef4444',
        hoverBorder: 'rgba(239, 68, 68, 0.2)',
        hoverShadow: '0 2px 8px rgba(239, 68, 68, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
      },
      common: {
        defaultColor: 'rgba(248, 248, 250, 0.92)',
        defaultDot: 'rgba(255, 255, 255, 0.28)',
        disabledDot: 'rgba(255, 255, 255, 0.14)',
        flowGradient: 'linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.08), transparent)',
      },
    },
    
    button: {
      
      default: {
        background: 'rgba(255, 255, 255, 0.14)',
        color: '#d0d0d6',
        border: 'transparent',
        shadow: 'none',
      },
      hover: {
        background: 'rgba(255, 255, 255, 0.22)',
        color: '#e8e8ec',
        border: 'transparent',
        shadow: 'none',
        transform: 'none',
      },
      active: {
        background: 'rgba(255, 255, 255, 0.18)',
        color: '#e8e8ec',
        border: 'transparent',
        shadow: 'none',
        transform: 'none',
      },
      
      
      primary: {
        default: {
          background: 'rgba(255, 255, 255, 0.16)',
          color: '#f4f4f5',
          border: 'transparent',
          shadow: 'none',
        },
        hover: {
          background: 'rgba(255, 255, 255, 0.24)',
          color: '#fafafa',
          border: 'transparent',
          shadow: 'none',
          transform: 'none',
        },
        active: {
          background: 'rgba(255, 255, 255, 0.2)',
          color: '#fafafa',
          border: 'transparent',
          shadow: 'none',
          transform: 'none',
        },
      },
      
      
      ghost: {
        default: {
          background: 'transparent',
          color: '#d0d0d6',
          border: 'transparent',
          shadow: 'none',
        },
        hover: {
          background: 'rgba(255, 255, 255, 0.14)',
          color: '#e8e8ec',
          border: 'transparent',
          shadow: 'none',
          transform: 'none',
        },
        active: {
          background: 'rgba(255, 255, 255, 0.10)',
          color: '#e8e8ec',
          border: 'transparent',
          shadow: 'none',
          transform: 'none',
        },
      },
    },
  },
  
  
  
  
  monaco: {
    base: 'vs-dark',
    inherit: true,
    rules: [], 
    colors: {
      background: '#242436',
      foreground: '#d6d6dc',
      lineHighlight: '#2a2a3e',
      selection: 'rgba(255, 255, 255, 0.18)',
      cursor: '#e0e0e6',
    },
  },
};





