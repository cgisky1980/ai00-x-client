 

import { parse, Allow } from 'partial-json';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('PartialJsonParser');

 
export function parsePartialJson(jsonStr: string): Record<string, any> {
  if (!jsonStr || jsonStr.trim() === '') {
    return {};
  }

  try {
    
    return JSON.parse(jsonStr);
  } catch {
    try {
      
      
      const result = parse(jsonStr, Allow.ALL);
      return result || {};
    } catch (error) {
      log.warn('Failed to parse partial JSON', error);
      return {};
    }
  }
}

 
export function isFieldComplete(jsonStr: string, fieldName: string): boolean {
  const parsed = parsePartialJson(jsonStr);
  return fieldName in parsed && parsed[fieldName] !== null && parsed[fieldName] !== undefined;
}

 
export function getFieldValue<T = any>(
  jsonStr: string, 
  fieldName: string, 
  defaultValue?: T
): T | undefined {
  const parsed = parsePartialJson(jsonStr);
  return parsed[fieldName] !== undefined ? parsed[fieldName] : defaultValue;
}

 
export function getFirstAvailableField<T = any>(
  jsonStr: string,
  fieldNames: string[],
  defaultValue?: T
): T | undefined {
  const parsed = parsePartialJson(jsonStr);
  
  for (const fieldName of fieldNames) {
    if (fieldName in parsed && parsed[fieldName] !== null && parsed[fieldName] !== undefined) {
      return parsed[fieldName];
    }
  }
  
  return defaultValue;
}

