/**
 * @ai00-x/design-system · web 出口（web-ui API 兼容系）
 *
 * 物理迁移自 web-ui component-library（2026-08），props API 与原版完全一致：
 * 182 处 web-ui 调用点经 '@/component-library' re-export 零改动消费。
 * 零引用组件（Avatar/Empty/FilterPill/StreamText/TextStrokeEffect/CubeLogo）
 * 已于同质去重时删除。
 *
 * 文案：组件内 label(key, fallback)，消费方启动时 setComponentLabels 注册覆盖
 * （见 lib/labels.ts）以接入自身 i18n。
 */
export * from './lib/labels';
export { PortalContainerContext as DsPortalContainerContext } from './lib/portal';

export * from './components/web/Alert';
export * from './components/web/Badge';
export * from './components/web/Button';
export * from './components/web/Card';
export * from './components/web/Checkbox';
export * from './components/web/ConfigPage';
export * from './components/web/ConfirmDialog';
export * from './components/web/CubeLoading';
export * from './components/web/DotMatrixLoader';
export * from './components/web/feedback/StarRating';
export * from './components/web/IconButton';
export * from './components/web/Input';
export * from './components/web/InputDialog';
export * from './components/web/Modal';
export * from './components/web/NumberInput';
export * from './components/web/Search';
export * from './components/web/Select';
export * from './components/web/Switch';
export * from './components/web/Tabs';
export * from './components/web/Tag';
export * from './components/web/Textarea';
export * from './components/web/Tooltip';
export * from './components/web/WindowControls';

/* ==== ds 系新组件（v0.13 扩展）：双出口直达 web-ui barrel ====
 * Tooltip 例外：web 系自有 BEM 版同名，react 版仅 ./react 出口 */
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuRadioGroup,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuItemIndicator,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from './components/dropdown-menu';

export {
  Popover,
  PopoverTrigger,
  PopoverAnchor,
  PopoverPortal,
  PopoverContent,
  PopoverClose,
} from './components/popover';

export {
  toast,
  toastSuccess,
  toastWarning,
  toastError,
  ToastProvider,
  type ToastVariant,
  type ToastOptions,
} from './components/toast';

export { Progress, type ProgressProps } from './components/progress';
export { Skeleton } from './components/skeleton';
export { Separator } from './components/separator';
export { Avatar, type AvatarProps } from './components/avatar';
export { Empty, type EmptyProps } from './components/empty';
export { ScrollArea } from './components/scroll-area';
export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
  AlertDialogSimple,
} from './components/alert-dialog';

export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from './components/table';

export {
  Drawer,
  DrawerTrigger,
  DrawerClose,
  DrawerPortal,
  DrawerOverlay,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
  DrawerPanel,
  type DrawerContentProps,
} from './components/drawer';

export { Pagination, type PaginationProps } from './components/pagination';
export { Tree, type TreeNodeData, type TreeProps } from './components/tree';

export {
  Timeline,
  TimelineItem,
  type TimelineProps,
  type TimelineItemProps,
} from './components/timeline';
export { Statistic, type StatisticProps } from './components/statistic';
export { Collapse, CollapseItem } from './components/collapse';
export { Steps, type StepsProps, type StepItem } from './components/steps';
