 

import { ThemeConfig, ThemeValidationResult, ColorValue } from '../types';

 
function isValidColor(color: ColorValue): boolean {
  
  const hexPattern = /^#([0-9A-Fa-f]{3}){1,2}$/;
  if (hexPattern.test(color)) {
    return true;
  }
  
  
  const rgbPattern = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/;
  if (rgbPattern.test(color)) {
    return true;
  }
  
  
  const hslPattern = /^hsla?\(\s*\d+\s*,\s*\d+%\s*,\s*\d+%\s*(,\s*[\d.]+\s*)?\)$/;
  if (hslPattern.test(color)) {
    return true;
  }
  
  
  const namedColors = ['transparent', 'currentColor'];
  if (namedColors.includes(color)) {
    return true;
  }
  
  return false;
}

 
function calculateContrast(_color1: string, _color2: string): number {
  
  
  return 4.5;
}

 
export class ThemeValidator {
   
  validate(theme: ThemeConfig): ThemeValidationResult {
    const errors: ThemeValidationResult['errors'] = [];
    const warnings: ThemeValidationResult['warnings'] = [];
    
    
    this.validateBasicFields(theme, errors);
    
    
    this.validateColors(theme, errors, warnings);
    
    
    this.validateEffects(theme, errors, warnings);
    
    
    this.validateContrast(theme, warnings);
    
    
    this.validateCompleteness(theme, warnings);
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
  
   
  private validateBasicFields(
    theme: ThemeConfig,
    errors: ThemeValidationResult['errors']
  ): void {
    if (!theme.id || theme.id.trim() === '') {
      errors.push({
        path: 'id',
        message: 'Theme id cannot be empty',
        code: 'MISSING_ID',
      });
    }
    
    if (!theme.name || theme.name.trim() === '') {
      errors.push({
        path: 'name',
        message: 'Theme name cannot be empty',
        code: 'MISSING_NAME',
      });
    }
    
    if (!theme.type || !['dark', 'light'].includes(theme.type)) {
      errors.push({
        path: 'type',
        message: 'Theme type must be "dark" or "light"',
        code: 'INVALID_TYPE',
      });
    }
  }
  
   
  private validateColors(
    theme: ThemeConfig,
    errors: ThemeValidationResult['errors'],
    _warnings: ThemeValidationResult['warnings']
  ): void {
    if (!theme.colors) {
      errors.push({
        path: 'colors',
        message: 'Missing color configuration',
        code: 'MISSING_COLORS',
      });
      return;
    }
    
    
    if (!theme.colors.background) {
      errors.push({
        path: 'colors.background',
        message: 'Missing background color configuration',
        code: 'MISSING_BACKGROUND_COLORS',
      });
    } else {
      this.validateColorGroup('colors.background', theme.colors.background as unknown as Record<string, ColorValue>, errors);
    }
    
    
    if (!theme.colors.text) {
      errors.push({
        path: 'colors.text',
        message: 'Missing text color configuration',
        code: 'MISSING_TEXT_COLORS',
      });
    } else {
      this.validateColorGroup('colors.text', theme.colors.text as unknown as Record<string, ColorValue>, errors);
    }
    
    
    if (!theme.colors.accent) {
      errors.push({
        path: 'colors.accent',
        message: 'Missing accent color configuration',
        code: 'MISSING_ACCENT_COLORS',
      });
    } else {
      this.validateColorGroup('colors.accent', theme.colors.accent as unknown as Record<string, ColorValue>, errors);
    }
  }
  
   
  private validateColorGroup(
    path: string,
    colorGroup: Record<string, ColorValue>,
    errors: ThemeValidationResult['errors']
  ): void {
    Object.entries(colorGroup).forEach(([key, value]) => {
      if (!isValidColor(value)) {
        errors.push({
          path: `${path}.${key}`,
          message: `Invalid color value: ${value}`,
          code: 'INVALID_COLOR_FORMAT',
        });
      }
    });
  }
  
   
  private validateEffects(
    theme: ThemeConfig,
    _errors: ThemeValidationResult['errors'],
    warnings: ThemeValidationResult['warnings']
  ): void {
    if (!theme.effects) {
      warnings.push({
        path: 'effects',
        message: 'Missing effects configuration; default values will be used',
        code: 'MISSING_EFFECTS',
      });
    }
  }
  
   
  private validateContrast(
    theme: ThemeConfig,
    warnings: ThemeValidationResult['warnings']
  ): void {
    if (!theme.colors) {
      return;
    }
    
    
    const textPrimary = theme.colors.text.primary;
    const bgPrimary = theme.colors.background.primary;
    
    const contrast = calculateContrast(textPrimary, bgPrimary);
    
    if (contrast < 4.5) {
      warnings.push({
        path: 'colors',
        message: `Contrast between primary text and background (${contrast.toFixed(2)}) is below WCAG AA (4.5:1)`,
        code: 'LOW_CONTRAST',
      });
    }
  }
  
   
  private validateCompleteness(
    theme: ThemeConfig,
    warnings: ThemeValidationResult['warnings']
  ): void {
    if (!theme.motion) {
      warnings.push({
        path: 'motion',
        message: 'Missing motion configuration; default values will be used',
        code: 'MISSING_MOTION',
      });
    }
    
    if (!theme.typography) {
      warnings.push({
        path: 'typography',
        message: 'Missing typography configuration; default values will be used',
        code: 'MISSING_TYPOGRAPHY',
      });
    }
    
    if (!theme.monaco) {
      warnings.push({
        path: 'monaco',
        message: 'Missing Monaco Editor configuration; default theme will be used',
        code: 'MISSING_MONACO',
      });
    }
  }
}


export const themeValidator = new ThemeValidator();
