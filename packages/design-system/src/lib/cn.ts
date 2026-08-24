import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并类名：clsx 条件 + tailwind-merge 去重（消费方混用 Tailwind 工具类时正确合并） */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
