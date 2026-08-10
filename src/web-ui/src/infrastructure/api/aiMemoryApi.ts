 

import { invoke } from '@tauri-apps/api/core';

export type MemoryType = 
  | 'tech_preference' 
  | 'project_context' 
  | 'user_habit' 
  | 'code_pattern' 
  | 'decision' 
  | 'other';

export interface AIMemory {
  id: string;
  title: string;
  content: string;
  type: MemoryType;
  tags: string[];
  source: string;
  created_at: string;
  updated_at: string;
  importance: number; // 1-5
  enabled: boolean;
}

export interface CreateMemoryRequest {
  title: string;
  content: string;
  type: MemoryType;
  importance: number;
  tags?: string[];
}

export interface UpdateMemoryRequest {
  id: string;
  title: string;
  content: string;
  type: MemoryType;
  importance: number;
  tags: string[];
  enabled: boolean;
}

 
export async function getAllMemories(): Promise<AIMemory[]> {
  return await invoke<AIMemory[]>('get_all_memories');
}

 
export async function addMemory(request: CreateMemoryRequest): Promise<AIMemory> {
  return await invoke<AIMemory>('add_memory', { request });
}

 
export async function updateMemory(request: UpdateMemoryRequest): Promise<boolean> {
  return await invoke<boolean>('update_memory', { request });
}

 
export async function deleteMemory(id: string): Promise<boolean> {
  return await invoke<boolean>('delete_memory', { id });
}

 
export async function toggleMemory(id: string): Promise<boolean> {
  return await invoke<boolean>('toggle_memory', { id });
}

