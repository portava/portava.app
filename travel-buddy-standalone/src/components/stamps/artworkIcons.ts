import { MapPin, Users, Gem, ShieldCheck, Crown, Ticket, Sparkles, Star, Plane, Route, MessageCircle, Image, Footprints } from 'lucide-react-native';
import type { ComponentType } from 'react';

type StampIcon = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
const ICONS: Record<string, StampIcon> = { MapPin, Users, Gem, ShieldCheck, Crown, Ticket, Sparkles, Star, Plane, Route, MessageCircle, Image, Footprints };
export const resolveStampArtworkIcon = (key: string): StampIcon => ICONS[key] ?? MapPin;
