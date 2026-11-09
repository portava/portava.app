import React, { useEffect, useRef, useState } from 'react';
import { Animated, Modal, PanResponder, Pressable, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, X } from 'lucide-react-native';
import { avatar } from '../../theme/tokens.ts';
import { DisplayMediaImage } from './DisplayMediaImage.tsx';
import { usePrivateSurfaceKey } from '../../hooks/usePrivateSurfaceKey.ts';
import { useMediaSurfaceActivity } from '../../hooks/useMediaSurfaceActivity.ts';

export interface FullscreenPhotoProps {
  uri: string;
  /** Original image references, never thumbnail URLs. */
  photos?: string[];
  children?: React.ReactNode;
  fullscreenOnly?: boolean;
  onClose?: () => void;
  style?: StyleProp<ViewStyle>;
  filterId?: string;
  filterIntensity?: number;
}

/** Keeps private media scoped to the initiating session, and mounts a full-size
 * image only after an explicit tap. Pinch/pan and the zoom buttons work on both
 * native platforms; buttons also support keyboard and screen-reader users. */
export function FullscreenPhoto(props: FullscreenPhotoProps) {
  const scope = usePrivateSurfaceKey();
  return <PhotoForViewer key={`${scope}:${props.uri}`} {...props} />;
}

function PhotoForViewer({ uri, photos, children, style, filterId, filterIntensity, fullscreenOnly = false, onClose }: FullscreenPhotoProps) {
  const [open, setOpen] = useState(fullscreenOnly);
  const close = () => { setOpen(false); if (fullscreenOnly) onClose?.(); };
  const activity = useMediaSurfaceActivity(close);
  const images = [...new Set(photos?.length ? photos : [uri])].filter(Boolean);
  const [index, setIndex] = useState(Math.max(0, images.indexOf(uri)));
  const dimensions = useWindowDimensions();
  const [size, setSize] = useState({ width: dimensions.width, height: dimensions.height - 150 });
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const latest = useRef(transform);
  const animated = useRef({ scale: new Animated.Value(1), x: new Animated.Value(0), y: new Animated.Value(0) }).current;
  const started = useRef({ scale: 1, x: 0, y: 0, distance: 0, dx: 0, dy: 0 });
  const lastTap = useRef(0);
  const activeUri = images[index] ?? uri;
  const reset = () => update(1, 0, 0);
  useEffect(() => { reset(); }, [activeUri, dimensions.width, dimensions.height, open]);
  function update(scale: number, x: number, y: number, commit = true) {
    scale = Math.max(1, Math.min(4, scale));
    const maxX = size.width * (scale - 1) / 2;
    const maxY = size.height * (scale - 1) / 2;
    const next = { scale, x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
    latest.current = next;
    animated.scale.setValue(next.scale); animated.x.setValue(next.x); animated.y.setValue(next.y);
    if (commit) setTransform(next);
  }
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { started.current = { ...latest.current, distance: 0, dx: 0, dy: 0 }; },
    onPanResponderMove: (event, gesture) => {
      const touches = event.nativeEvent.touches;
      if (touches.length >= 2) {
        const distance = Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
        if (!started.current.distance) started.current = { ...latest.current, distance, dx: gesture.dx, dy: gesture.dy };
        if (started.current.distance > 0) update(started.current.scale * distance / started.current.distance, started.current.x, started.current.y, false);
      } else {
        if (started.current.distance) started.current = { ...latest.current, distance: 0, dx: gesture.dx, dy: gesture.dy };
        update(started.current.scale, started.current.x + gesture.dx - started.current.dx, started.current.y + gesture.dy - started.current.dy, false);
      }
    },
    onPanResponderRelease: (_event, gesture) => {
      setTransform(latest.current);
      if (Math.abs(gesture.dx) + Math.abs(gesture.dy) > 8 || started.current.distance) return;
      const now = Date.now();
      if (lastTap.current && now - lastTap.current < 300) { update(latest.current.scale > 1 ? 1 : 2, 0, 0); lastTap.current = 0; }
      else lastTap.current = now;
    },
  });
  return <View style={style}>
    {!fullscreenOnly && <Pressable accessibilityRole="button" accessibilityLabel="View photo full screen" onPress={(event) => { event.stopPropagation?.(); if (activity.isCurrent()) setOpen(true); }} style={StyleSheet.absoluteFill}>
      {children}
      <View style={s.expand} pointerEvents="none"><Maximize2 size={22} color="#fff" /></View>
    </Pressable>}
    {open && activity.active ? <Modal visible animationType="fade" presentationStyle="fullScreen" supportedOrientations={['portrait', 'landscape']} onRequestClose={close}>
      <SafeAreaView style={s.root} accessibilityViewIsModal>
        <View style={s.toolbar}><Text style={s.text}>{images.length > 1 ? `${index + 1} of ${images.length}` : 'Photo'}</Text><Pressable style={s.button} accessibilityRole="button" accessibilityLabel="Close full-screen photo" onPress={close}><X color="#fff" size={26} /></Pressable></View>
        <View testID="fullscreen-photo-canvas" style={s.canvas} onLayout={event => setSize(event.nativeEvent.layout)} {...responder.panHandlers}>
          <Animated.View testID="fullscreen-photo-transform" style={[StyleSheet.absoluteFill, { transform: [{ translateX: animated.x }, { translateY: animated.y }, { scale: animated.scale }] }]}>
            <DisplayMediaImage uri={activeUri} width={size.width} height={size.height} resizeMode="contain" style={StyleSheet.absoluteFill} filterId={filterId} filterIntensity={filterIntensity} />
          </Animated.View>
        </View>
        <View style={s.tools}>
          {images.length > 1 ? <Pressable style={s.button} disabled={index === 0} accessibilityState={{ disabled: index === 0 }} accessibilityRole="button" accessibilityLabel="Previous photo" onPress={() => setIndex(value => Math.max(0, value - 1))}><ChevronLeft color={index === 0 ? '#666' : '#fff'} /></Pressable> : null}
          <Pressable style={s.button} accessibilityRole="button" accessibilityLabel="Zoom out" onPress={() => update(latest.current.scale - 0.5, 0, 0)}><Minus color="#fff" /></Pressable>
          <Pressable style={s.reset} accessibilityRole="button" accessibilityLabel="Reset photo zoom" onPress={reset}><Text style={s.text}>{Math.round(transform.scale * 100)}%</Text></Pressable>
          <Pressable style={s.button} accessibilityRole="button" accessibilityLabel="Zoom in" onPress={() => update(latest.current.scale + 0.5, 0, 0)}><Plus color="#fff" /></Pressable>
          {images.length > 1 ? <Pressable style={s.button} disabled={index >= images.length - 1} accessibilityState={{ disabled: index >= images.length - 1 }} accessibilityRole="button" accessibilityLabel="Next photo" onPress={() => setIndex(value => Math.min(images.length - 1, value + 1))}><ChevronRight color={index >= images.length - 1 ? '#666' : '#fff'} /></Pressable> : null}
        </View>
      </SafeAreaView>
    </Modal> : null}
  </View>;
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  text: { color: '#fff', fontSize: 16 },
  button: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  reset: { minWidth: 64, height: 48, alignItems: 'center', justifyContent: 'center' },
  tools: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  canvas: { flex: 1, overflow: 'hidden' },
  expand: { position: 'absolute', top: 10, right: 10, width: avatar.s44, height: avatar.s44, borderRadius: avatar.s44 / 2, backgroundColor: 'rgba(0,0,0,0.65)', alignItems: 'center', justifyContent: 'center' },
});
