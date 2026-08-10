import {
    Folder, FolderOpen, File, FileText, Image, Music, Video, Gamepad2,
    Code, Terminal, Cpu, Database, Cloud, Server, Wifi, Bluetooth,
    Settings, User, Users, Mail, MessageSquare, Phone, Calendar, Clock,
    Map, Navigation, Home, Building, Store, ShoppingCart, CreditCard, Wallet,
    Briefcase, Clipboard, Book, Bookmark, Star, Heart, Smile, Zap,
    Activity, Award, Gift, Camera, Mic, Headphones, Speaker, Monitor,
    Smartphone, Tablet, Laptop, Printer, Trash2, Archive, Download, Upload
} from "lucide-react"

export const ICON_MAP: Record<string, React.ComponentType<any>> = {
    Folder, FolderOpen, File, FileText, Image, Music, Video, Gamepad2,
    Code, Terminal, Cpu, Database, Cloud, Server, Wifi, Bluetooth,
    Settings, User, Users, Mail, MessageSquare, Phone, Calendar, Clock,
    Map, Navigation, Home, Building, Store, ShoppingCart, CreditCard, Wallet,
    Briefcase, Clipboard, Book, Bookmark, Star, Heart, Smile, Zap,
    Activity, Award, Gift, Camera, Mic, Headphones, Speaker, Monitor,
    Smartphone, Tablet, Laptop, Printer, Trash2, Archive, Download, Upload
}

export const ICON_NAMES = Object.keys(ICON_MAP)
