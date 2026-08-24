/**
 * @ai00-x/design-system React 组件入口（ds 精简系）
 *
 * 仅保留有真实消费者的组件：BrandMark（品牌灵印）、Button/Card/Input/
 * ContextMenu（underlay-ui 桌面层）、cn。富 API 组件（Modal/Select/Tooltip/
 * Tabs 等）统一走 './web' 出口——2026-08 同质去重后双出口分工：
 *   ./react = 精简 ds 系（Radix 原语 + ds- 类）
 *   ./web   = web-ui API 全家（27 组件，BEM token 化）
 * 样式：@import "@ai00-x/design-system/styles";
 */
export { cn } from './lib/cn';
export { setComponentLabels, label } from './lib/labels';
export { PortalContainerContext as DsPortalContainerContext } from './lib/portal';

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
} from './components/context-menu';

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
  Tooltip,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipPortal,
  TooltipContent,
} from './components/tooltip';

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

export { BrandMark, type BrandMarkProps, type BrandMarkVariant } from './components/brand-mark';
export { Button, type ButtonProps } from './components/button';
export {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from './components/card';
export { Input, Textarea } from './components/input';
