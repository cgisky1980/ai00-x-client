/**
 * 统一实现见 packages/shared/src/location/LocationPicker.tsx（@ai00-x/shared）。
 * 此处注入 loader-ui 的 t（默认 translation 命名空间）和 locale，保持对旧导入路径的兼容。
 */
import { LocationPicker as SharedLocationPicker, type LocationPickerProps } from '@ai00-x/shared';
import { useI18n } from '@/lib/i18n';

export type { LocationPickerProps };

export function LocationPicker(props: Omit<LocationPickerProps, 't' | 'locale'>) {
  const { t, locale } = useI18n();
  return <SharedLocationPicker {...props} t={t} locale={locale} />;
}