/**
 * ShareSheet — share options for a post.
 *
 * Targets and how they're recorded:
 *   Share Post   → native OS share sheet        → target='external'
 *   Copy Link    → copies URL only              → target='copy_link'
 *   Send in a chat → real recipient picker; sends the post as a post_card
 *                    system message into the chosen Telegraph thread.
 *                    target derived from thread type:
 *                      direct → 'dm', trip → 'trip_crew', circle → 'circle'
 *
 * Chats carry a reference and the sender's caption. The recipient resolves current
 * content, media and attribution. Encrypted conversations send an encrypted permalink.
 *
 * The parent (PostEngagementBar) calls recordShare(postId, target) via
 * onShareSuccess so the correct target is always persisted.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Platform,
  Alert,
  ScrollView,
  ToastAndroid,
  TextInput,
  Image,
  ActivityIndicator,
  FlatList,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import {
  Link,
  MessageCircle,
  Send,
  Globe,
  Users,
  PlusCircle,
  X,
  Search,
  Bookmark,
  Star,
} from 'lucide-react-native';
import { PortavaShareIcon } from './icons/PortavaShareIcon.tsx';
import { closeThenNavigate } from '../lib/deferredNavigate.ts';
import { canonicalUrl, canonicalOrigin } from '../constants/canonicalUrl.ts';
import { color, space, radius, shadow, avatar, icon } from '../theme/tokens.ts';
import { PortavaSheet } from './ui/PortavaSheet.tsx';
import { Avatar } from './ui/Avatar.tsx';
import { SectionHeader } from './ui/SectionHeader.tsx';
import { getMyThreads, sendMessage, openDirectThread } from '../services/messaging.ts';
import type { ThreadSummary } from '../services/messaging.ts';
import { fetchConversationProjection } from '../features/telegraph/conversation/conversationProjection.ts';
import { canonicalMediaLink } from '../features/telegraph/sharing/canonicalMediaLink.ts';
import { searchUsers } from '../services/follows.ts';
import type { TravelerSearchResult } from '../services/follows.ts';
import { useInputAccountEpoch } from '../platform/input-assistance/hooks/useInputAccountEpoch.ts';
import { createInputRequestScheduler } from '../platform/input-assistance/services/inputRequestScheduler.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from '../services/discoveryViewerScope.ts';
import { shareObjectIntoThread } from '../features/telegraph/sharing/shareApi.ts';
import { PostSaveDestinationPanel } from './PostSaveDestinationPanel.tsx';

export type ShareTarget = 'external' | 'copy_link' | 'dm' | 'group_chat' | 'trip_crew' | 'circle';

interface CommonProps {
  visible: boolean;
  onClose: () => void;
  onShareSuccess?: (target: ShareTarget) => void;
  /**
   * When set (the media action rail's Share through Telegraph, census-media
   * §21), the in-app send writes a Telegraph §5 object REFERENCE into the
   * chosen thread via POST /threads/:id/share — the server resolves the post
   * for each reader at read time, so a later privacy change or deletion is
   * honoured — instead of the post_card snapshot. Unset: unchanged behaviour.
   */
  telegraphObject?: { objectType: 'POST' | 'MEDIA'; objectId: string } | null;
}
type Props = CommonProps & (
  | { postId: string; canonicalLink?: never }
  | { postId?: never; canonicalLink: { url: string; title: string } }
);

function postPermalink(postId: string): string {
  return canonicalUrl(`/posts/${postId}`);
}

function targetForThread(threadType: ThreadSummary['threadType']): ShareTarget {
  if (threadType === 'trip') return 'trip_crew';
  if (threadType === 'circle') return 'circle';
  if (threadType === 'group') return 'group_chat';
  return 'dm';
}

export function ShareSheet({ visible, postId = '', canonicalLink, onClose, onShareSuccess, telegraphObject }: Props) {
  const linkOnly = canonicalLink !== undefined;
  const shareTitle = canonicalLink?.title ?? 'Share Post';
  const shareUrl = useMemo(() => {
    if (!canonicalLink) return postPermalink(postId);
    try {
      const url = new URL(canonicalLink.url);
      return url.origin === new URL(canonicalOrigin()).origin && !url.username && !url.password ? url.toString() : null;
    } catch { return null; }
  }, [postId, canonicalLink?.url]);
  const [mode, setMode] = useState<'menu' | 'picker' | 'memory' | 'highlight'>('menu');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadsFailed, setThreadsFailed] = useState(false);
  const threadLoadVersion = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [sending, setSending] = useState(false);

  // Thread search
  const [threadSearch, setThreadSearch] = useState('');
  const [userResults, setUserResults] = useState<TravelerSearchResult[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [userSearchFailed, setUserSearchFailed] = useState(false);
  const accountEpoch = useInputAccountEpoch();
  const context = useMemo(() => ({ active: false, scope: currentDiscoveryScope() }), [visible, accountEpoch, postId, canonicalLink?.url, telegraphObject?.objectType, telegraphObject?.objectId]);
  const currentContext = useRef(context);
  const scheduler = useMemo(createInputRequestScheduler, []);
  const pickerVersionRef = useRef(0);
  const pickerVersion = pickerVersionRef.current;
  const pickerActive = useRef(false);
  const actionVersionRef = useRef(0);
  const actionVersion = actionVersionRef.current;
  const sendingRef = useRef(false);
  const nativeSharePending = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; nativeSharePending.current = null; }; }, []);
  const isCurrent = () => context.active && currentContext.current === context && isCurrentDiscoveryScope(context.scope);
  const isCurrentPicker = () => isCurrent() && pickerActive.current && pickerVersion === pickerVersionRef.current;
  const isCurrentAction = () => isCurrentPicker() && actionVersion === actionVersionRef.current;

  function resetSearch() {
    actionVersionRef.current++;
    scheduler.cancel();
    setThreadSearch('');
    setUserResults([]);
    setSearchingUsers(false);
    setUserSearchFailed(false);
    setSelectedId(null);
    sendingRef.current = false;
    setSending(false);
  }

  function handleClose() {
    if (!isCurrent()) return;
    context.active = false;
    pickerActive.current = false;
    pickerVersionRef.current++;
    resetSearch();
    setThreads([]);
    onClose();
  }

  function closePicker() {
    if (!isCurrentPicker()) return;
    pickerActive.current = false;
    pickerVersionRef.current++;
    resetSearch();
    setThreads([]);
    setLoadingThreads(false);
    setThreadsFailed(false);
    setMode('menu');
  }

  useLayoutEffect(() => {
    currentContext.current = context;
    context.active = visible;
    pickerActive.current = false;
    pickerVersionRef.current++;
    resetSearch();
    setMode('menu');
    setCaption('');
    setThreads([]);
    setLoadingThreads(false);
    setThreadsFailed(false);
    if (visible) nativeSharePending.current = null;
    return () => {
      context.active = false;
      scheduler.cancel();
    };
  }, [context]);

  function openPicker() {
    if (!isCurrent() || pickerActive.current) return;
    pickerActive.current = true;
    const version = ++pickerVersionRef.current;
    resetSearch();
    setMode('picker');
    setThreads([]);
    void loadThreads(version);
  }

  async function loadThreads(version = pickerVersionRef.current) {
    if (!isCurrent() || !pickerActive.current || version !== pickerVersionRef.current) return;
    const request = ++threadLoadVersion.current;
    const isCurrentHydration = () => isCurrent() && pickerActive.current && version === pickerVersionRef.current && request === threadLoadVersion.current;
    setLoadingThreads(true);
    setThreadsFailed(false);
    try {
      const res = await getMyThreads();
      if (!isCurrentHydration()) return;
      if (res.ok && res.data && Array.isArray(res.data.threads)) setThreads(res.data.threads);
      else setThreadsFailed(true);
    } catch {
      if (isCurrentHydration()) setThreadsFailed(true);
    } finally {
      if (isCurrentHydration()) setLoadingThreads(false);
    }
  }

  function handleSearchChange(text: string) {
    if (!isCurrentPicker()) return;
    resetSearch();
    setThreadSearch(text);
    if (!text.trim()) return;
    setSearchingUsers(true);
    scheduler.schedule(async (request) => {
      const isCurrentRequest = () => isCurrentPicker() && request.isCurrent();
      if (!isCurrentRequest()) return;
      try {
        const res = await searchUsers(text.trim(), 10, { ...request, isCurrent: isCurrentRequest, scope: context.scope });
        if (!isCurrentRequest()) return;
        if (res.ok && res.data) {
          setUserResults(res.data);
        } else {
          setUserResults([]);
          setUserSearchFailed(true);
        }
      } catch {
        if (isCurrentRequest()) {
          setUserResults([]);
          setUserSearchFailed(true);
        }
      } finally {
        if (isCurrentRequest()) setSearchingUsers(false);
      }
    }, 350);
  }

  function selectThread(thread: ThreadSummary) {
    if (!isCurrentAction() || sendingRef.current || !threads.includes(thread) || selectedId === thread.id) return;
    actionVersionRef.current++;
    setSelectedId(thread.id);
  }

  async function sendToChat(threadId: string, knownEncryption?: boolean) {
    const encrypted = typeof knownEncryption === 'boolean' ? knownEncryption
      : (await fetchConversationProjection(threadId))?.conversation?.isE2ee;
    if (!isCurrentAction() || typeof encrypted !== 'boolean' || !shareUrl) return { ok: false };
    const note = caption.trim();
    if (encrypted) return sendMessage(threadId, [note, shareUrl].filter(Boolean).join('\n'), {isE2ee: true});
    const reference = telegraphObject ?? (linkOnly ? canonicalMediaLink(shareUrl) : null);
    if (reference) return shareObjectIntoThread(threadId, reference.objectType, reference.objectId, note || null);
    if (linkOnly) return sendMessage(threadId, [note, shareUrl].filter(Boolean).join('\n'));
    // Legacy readers understand post_card. Only the reference and sender's note belong in history.
    return sendMessage(threadId, JSON.stringify({postId, caption: note || undefined}), {msgType: 'system', subtype: 'post_card'});
  }

  async function handleUserResultPress(user: TravelerSearchResult) {
    if (!isCurrentAction() || sendingRef.current || !userResults.includes(user) || !shareUrl) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const threadRes = await openDirectThread(user.id);
      if (!isCurrentAction()) return;
      if (!threadRes.ok || !threadRes.data) {
        Alert.alert('Could not send', 'Could not open a chat with this user. Please try again.');
        return;
      }
      const threadId = threadRes.data.threadId;
      const msgRes = await sendToChat(threadId, threads.find(t => t.id === threadId)?.isE2ee);
      if (!isCurrentAction()) return;
      if (msgRes.ok) {
        onShareSuccess?.('dm');
        handleClose();
        Alert.alert('Sent!', linkOnly ? 'Link shared to your chat.' : 'Post shared to your chat.');
      } else {
        Alert.alert('Could not send', 'Something went wrong. Please try again.');
      }
    } catch {
      if (isCurrentAction()) Alert.alert('Could not send', 'Something went wrong. Please try again.');
    } finally {
      if (isCurrentAction()) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  }

  async function handleNativeShare() {
    if (!isCurrent() || !shareUrl) return;
    const scope = context.scope;
    const present = async () => {
      if (!mounted.current || !isCurrentDiscoveryScope(scope)) return;
      try {
        const result = await Share.share({
          message: linkOnly ? shareUrl : `Check out this post on Portava!\n${shareUrl}`,
          ...(Platform.OS === 'ios' ? { url: shareUrl } : {}),
        });
        if (mounted.current && isCurrentDiscoveryScope(scope) && result.action === Share.sharedAction) onShareSuccess?.('external');
      } catch {
        if (mounted.current && isCurrentDiscoveryScope(scope)) Alert.alert('Could not open sharing', 'Please try again, or use Copy Link.');
      }
    };
    // UIKit cannot present a second controller while this sheet is dismissing.
    // Use the actual native dismissal event, rather than guessing an animation delay.
    if (Platform.OS === 'ios') nativeSharePending.current = () => { void present(); };
    handleClose();
    if (Platform.OS !== 'ios') void present();
  }

  function handleDismiss() {
    const present = nativeSharePending.current;
    nativeSharePending.current = null;
    present?.();
  }

  function openProfileComposer() {
    if (!isCurrent() || linkOnly) return;
    const scope = context.scope;
    const navigate = () => {
      if (mounted.current && isCurrentDiscoveryScope(scope)) {
        router.push({ pathname: '/create', params: { sharePostId: postId } });
      }
    };
    if (Platform.OS === 'ios') nativeSharePending.current = navigate;
    handleClose();
    if (Platform.OS !== 'ios') navigate();
  }

  async function handleCopyLink() {
    if (!isCurrent() || !shareUrl) return;
    const scope = context.scope;
    handleClose();
    try {
      await Clipboard.setStringAsync(shareUrl);
      if (!mounted.current || !isCurrentDiscoveryScope(scope)) return;
      onShareSuccess?.('copy_link');
      if (Platform.OS === 'android') {
        ToastAndroid.show('Link copied', ToastAndroid.SHORT);
      } else {
        Alert.alert('Copied', linkOnly ? 'Link copied to clipboard.' : 'Post link copied to clipboard.');
      }
    } catch (_) {
      if (mounted.current && isCurrentDiscoveryScope(scope)) Alert.alert('Error', 'Could not copy link. Please try again.');
    }
  }

  async function handleSend() {
    if (!selectedId || !isCurrentAction() || sendingRef.current || !shareUrl) return;
    const thread = threads.find((t) => t.id === selectedId);
    if (!thread) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const res = await sendToChat(selectedId, thread.isE2ee);
      if (!isCurrentAction()) return;
      if (res.ok) {
        onShareSuccess?.(targetForThread(thread.threadType));
        handleClose();
        Alert.alert('Sent!', linkOnly ? 'Link shared to your chat.' : 'Post shared to your chat.');
      } else {
        Alert.alert('Could not send', 'Something went wrong. Please try again.');
      }
    } catch {
      if (isCurrentAction()) Alert.alert('Could not send', 'Something went wrong. Please try again.');
    } finally {
      if (isCurrentAction()) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  }

  return (
    <PortavaSheet
      visible={visible}
      onClose={handleClose}
      onDismiss={handleDismiss}
      avoidKeyboard={mode !== 'menu'}
      accessibilityLabel={linkOnly ? shareTitle : 'Share post'}
      closeAccessibilityLabel="Close share sheet"
      testID="share-sheet"
    >
        {(mode === 'memory' || mode === 'highlight') && !linkOnly ? <PostSaveDestinationPanel
          key={`${context.scope.viewer}:${postId}:${mode}`}
          postId={postId}
          destination={mode}
          active={visible && isCurrent()}
          onCancel={() => { if (isCurrent()) setMode('menu'); }}
          onSaved={(result) => {
            if (!isCurrent()) return;
            const destination = mode === 'memory' ? 'Memory' : 'Highlight';
            const scope = context.scope;
            const confirm = () => {
              if (!mounted.current || !isCurrentDiscoveryScope(scope)) return;
              if (result.memoryId) {
                Alert.alert('Saved', 'Added to your Memory.', [
                  { text: 'Done', style: 'cancel' },
                  { text: 'Open Memory', onPress: () => {
                    if (mounted.current && isCurrentDiscoveryScope(scope)) router.push(`/memory/${result.memoryId}` as never);
                  } },
                ]);
              } else Alert.alert('Saved', `Added to your ${destination}.`);
            };
            if (Platform.OS === 'ios') nativeSharePending.current = confirm;
            handleClose();
            if (Platform.OS !== 'ios') confirm();
          }}
        /> : mode === 'menu' ? (
          <>
            <View style={s.header}>
              <Text style={s.title}>{shareTitle}</Text>
              <Pressable onPress={handleClose} hitSlop={10}>
                <X size={20} color={color.ink} />
              </Pressable>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              bounces={false}
              contentContainerStyle={s.scrollContent}
            >
              {shareUrl === null ? <Text style={s.emptyLabel}>This link is unavailable.</Text> : <ShareOption
                iconBg="#EEF1FF"
                icon={<PortavaShareIcon size={20} color="#4A6CF7" />}
                label={linkOnly ? 'Share Link' : 'Share Post'}
                sub="Open share menu"
                onPress={handleNativeShare}
              />}

              <ShareOption
                iconBg="#EDF7EE"
                icon={<Link size={20} color={color.success} />}
                label="Copy Link"
                sub={linkOnly ? 'Copy the link' : 'Share the post URL'}
                onPress={handleCopyLink}
              />

              <SectionHeader>Share in app</SectionHeader>

              {!linkOnly && <ShareOption
                iconBg="#EEF1FF"
                icon={<Globe size={20} color="#4A6CF7" />}
                label="Share to my profile"
                sub="Repost with your own note and audience"
                onPress={openProfileComposer}
              />}

              {!linkOnly && <ShareOption
                iconBg="#EDF7EE"
                icon={<Bookmark size={20} color={color.success} />}
                label="Add to Memories"
                sub="Choose a Memory or create one"
                onPress={() => { if (isCurrent()) setMode('memory'); }}
              />}
              {!linkOnly && <ShareOption
                iconBg="#FFF3EE"
                icon={<Star size={20} color="#F97316" />}
                label="Add to Highlights"
                sub="Choose who can see it"
                onPress={() => { if (isCurrent()) setMode('highlight'); }}
              />}

              <ShareOption
                iconBg="#FFF3EE"
                icon={<MessageCircle size={20} color="#F97316" />}
                label="Send in a chat"
                sub={linkOnly ? 'Send the link to a Telegraph chat, trip crew, or circle' : 'Send this post to a Telegraph chat, trip crew, or circle'}
                onPress={openPicker}
              />
            </ScrollView>

            <Pressable style={s.cancel} onPress={handleClose}>
              <Text style={s.cancelText}>Cancel</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={s.header}>
              <Pressable onPress={closePicker} hitSlop={10}>
                <Text style={s.backText}>‹ Back</Text>
              </Pressable>
              <Text style={s.title}>Send to</Text>
              <Pressable onPress={handleClose} hitSlop={10}>
                <X size={20} color={color.ink} />
              </Pressable>
            </View>

            <TextInput
              style={s.captionInput}
              placeholder="Add a note (optional)…"
              placeholderTextColor={color.mute}
              value={caption}
              onChangeText={setCaption}
              maxLength={200}
              multiline
            />

            <Text style={s.chooseLabel}>CHOOSE A CHAT</Text>

            {threadsFailed && (
              <View style={s.loadingRow}>
                <Text style={s.emptyLabel}>Couldn't load your chats.</Text>
                <Pressable onPress={() => { void loadThreads(); }} accessibilityRole="button" accessibilityLabel="Retry loading chats" hitSlop={8}>
                  <Text style={s.startChatText}>Try again</Text>
                </Pressable>
              </View>
            )}

            {/* Search input */}
            <View style={s.searchRow}>
              <Search size={14} color={color.mute} style={{ flexShrink: 0 }} />
              <TextInput
                style={s.searchInput}
                placeholder="Search chats or find someone…"
                placeholderTextColor={color.mute}
                value={threadSearch}
                onChangeText={handleSearchChange}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
              />
              {threadSearch.length > 0 && (
                <Pressable onPress={() => handleSearchChange('')} hitSlop={8}>
                  <X size={13} color={color.mute} />
                </Pressable>
              )}
            </View>

            {/* New Telegraph — only when not in search mode */}
            {!threadSearch.trim() && (
              <Pressable
                style={s.newThreadRow}
                onPress={() => {
                  // BUG CC/CD fix: defer navigation until after the sheet close animation.
                  closeThenNavigate(handleClose, '/(tabs)/messages');
                }}
              >
                <View style={s.newThreadIcon}>
                  <PlusCircle size={16} color={color.signal} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.newThreadLabel}>New Telegraph</Text>
                  <Text style={s.newThreadSub}>Start a new conversation</Text>
                </View>
              </Pressable>
            )}

            {(() => {
              const isSearchActive = threadSearch.trim().length > 0;
              const filteredThreads = isSearchActive
                ? threads.filter((thread) => {
                    const q = threadSearch.toLowerCase();
                    if (thread.title?.toLowerCase().includes(q)) return true;
                    return thread.otherMembers.some(
                      (m) =>
                        m.name?.toLowerCase().includes(q) ||
                        m.handle?.toLowerCase().includes(q),
                    );
                  })
                : threads;
              if (loadingThreads) {
                return (
                  <View style={s.loadingRow}>
                    <ActivityIndicator size="small" color={color.signal} />
                  </View>
                );
              }

              if (!isSearchActive) {
                if (filteredThreads.length === 0) {
                  if (threadsFailed) return null;
                  return (
                    <View style={s.loadingRow}>
                      <MessageCircle size={24} color={color.faint} />
                      <Text style={s.emptyLabel}>No existing chats yet.</Text>
                    </View>
                  );
                }
                return (
                  <FlatList
                    data={filteredThreads}
                    keyExtractor={(th) => th.id}
                    style={s.list}
                    renderItem={({ item: thread }) => (
                      <ThreadRow
                        thread={thread}
                        selected={selectedId === thread.id}
                        onPress={() => selectThread(thread)}
                      />
                    )}
                    ItemSeparatorComponent={() => (
                      <View style={{ height: 1, backgroundColor: color.haze }} />
                    )}
                  />
                );
              }

              // Search active — show threads and user results together
              const noneFound = filteredThreads.length === 0 && !searchingUsers && !userSearchFailed && userResults.length === 0;
              if (noneFound) {
                return (
                  <View style={s.loadingRow}>
                    <MessageCircle size={24} color={color.faint} />
                    <Text style={s.emptyLabel}>No results for "{threadSearch}".</Text>
                  </View>
                );
              }

              return (
                <ScrollView style={s.list} keyboardShouldPersistTaps="handled">
                  {filteredThreads.map((thread, i) => (
                    <View key={thread.id}>
                      <ThreadRow
                        thread={thread}
                        selected={selectedId === thread.id}
                        onPress={() => selectThread(thread)}
                      />
                      {i < filteredThreads.length - 1 && (
                        <View style={{ height: 1, backgroundColor: color.haze }} />
                      )}
                    </View>
                  ))}
                  {filteredThreads.length > 0 && <View style={{ height: 1, backgroundColor: color.haze }} />}
                  <View style={s.peopleDividerRow}>
                    <Text style={s.peopleDividerText}>PEOPLE</Text>
                  </View>
                  {searchingUsers ? (
                    <View style={s.loadingRow}>
                      <ActivityIndicator size="small" color={color.signal} />
                    </View>
                  ) : userSearchFailed ? (<View style={s.loadingRow}><Text style={s.emptyLabel}>We couldn't search people just now.</Text><Pressable onPress={() => handleSearchChange(threadSearch)} accessibilityRole="button" accessibilityLabel="Retry" hitSlop={8}><Text style={s.startChatText}>Try again</Text></Pressable></View>) : userResults.length > 0 ? (
                    userResults.map((user, i) => (
                      <View key={user.id}>
                        <UserResultRow user={user} onPress={() => handleUserResultPress(user)} />
                        {i < userResults.length - 1 && (
                          <View style={{ height: 1, backgroundColor: color.haze }} />
                        )}
                      </View>
                    ))
                  ) : (
                    <View style={s.loadingRow}>
                      <MessageCircle size={20} color={color.faint} />
                      <Text style={s.emptyLabel}>No people found.</Text>
                    </View>
                  )}
                </ScrollView>
              );
            })()}

            <Pressable
              style={[s.sendBtn, (!selectedId || sending) && s.sendBtnDisabled]}
              onPress={handleSend}
              disabled={!selectedId || sending || !shareUrl}
            >
              {sending ? (
                <ActivityIndicator size="small" color={color.onInk} />
              ) : (
                <>
                  <Send size={15} color={color.onInk} />
                  <Text style={s.sendLabel}>Send</Text>
                </>
              )}
            </Pressable>
          </>
        )}
    </PortavaSheet>
  );
}

function ThreadRow({
  thread,
  selected,
  onPress,
}: {
  thread: ThreadSummary;
  selected: boolean;
  onPress: () => void;
}) {
  const isDirect = thread.threadType === 'direct';
  const other = thread.otherMembers[0];
  const displayName = thread.title ?? (isDirect && other ? other.name : 'Chat');
  const avatarUrl = isDirect && other ? other.avatarUrl : null;

  return (
    <Pressable style={[s.threadRow, selected && s.threadRowSelected]} onPress={onPress} accessibilityRole="button" accessibilityLabel={`Select ${displayName}`} accessibilityState={{ selected }}>
      <Avatar
        uri={avatarUrl}
        name={displayName}
        kind={thread.threadType === 'trip' ? 'trip' : thread.threadType === 'circle' ? 'circle' : 'person'}
        size={36}
        selected={selected}
      />
      <View style={{ flex: 1 }}>
        <Text style={[s.threadName, selected && s.threadNameSelected]} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={s.threadSub} numberOfLines={1}>
          {thread.threadType === 'trip'
            ? 'Trip chat'
            : thread.threadType === 'circle'
            ? 'Circle'
            : thread.threadType === 'group'
            ? 'Group chat'
            : thread.threadType === 'rent_buddy_booking'
            ? 'Travel partner chat'
            : 'Direct message'}
        </Text>
      </View>
      {selected && (
        <View style={s.checkBadge}>
          <Text style={s.checkText}>✓</Text>
        </View>
      )}
    </Pressable>
  );
}

function UserResultRow({
  user,
  onPress,
}: {
  user: TravelerSearchResult;
  onPress: () => void;
}) {
  const handle = user.username ? `@${user.username}` : null;
  const displayName = user.displayName ?? handle ?? 'Unknown';

  return (
    <Pressable style={s.threadRow} onPress={onPress}>
      <Avatar uri={user.avatarUrl} name={displayName} kind="person" size={36} />
      <View style={{ flex: 1 }}>
        <Text style={s.threadName} numberOfLines={1}>{displayName}</Text>
        {handle ? <Text style={s.threadSub} numberOfLines={1}>{handle}</Text> : null}
      </View>
      <View style={s.startChatBadge}>
        <Text style={s.startChatText}>Send</Text>
      </View>
    </Pressable>
  );
}

function ShareOption({
  iconBg,
  icon,
  label,
  sub,
  onPress,
}: {
  iconBg: string;
  icon: React.ReactNode;
  label: string;
  sub: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={s.option} onPress={onPress}>
      <View style={[s.iconWrap, { backgroundColor: iconBg }]}>{icon}</View>
      <View style={s.optionText}>
        <Text style={s.optionLabel}>{label}</Text>
        <Text style={s.optionSub}>{sub}</Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: color.ink,
  },
  backText: {
    fontSize: 15,
    fontWeight: '600',
    color: color.signalStrong,
  },
  scrollContent: {
    gap: 0,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionText: {
    flex: 1,
    gap: 2,
  },
  optionLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: color.ink,
  },
  optionSub: {
    fontSize: 12,
    color: color.mute,
  },
  cancel: {
    marginHorizontal: space.lg,
    marginTop: space.sm,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: color.haze,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: color.ink,
  },

  // Picker
  captionInput: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: 14,
    color: color.ink,
    minHeight: 42,
    maxHeight: 80,
  },
  chooseLabel: {
    fontSize: 10,
    fontFamily: 'Courier',
    color: color.mute,
    letterSpacing: 0.5,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  newThreadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.signal + '40',
    backgroundColor: color.signal + '07',
    marginBottom: space.sm,
  },
  newThreadIcon: {
    width: avatar.s36, height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    backgroundColor: color.signal + '15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  newThreadLabel: { fontSize: 14, fontWeight: '700', color: color.signalStrong },
  newThreadSub: { fontSize: 11, color: color.mute, marginTop: 1 },

  loadingRow: { alignItems: 'center', justifyContent: 'center', paddingVertical: space.xl, gap: space.sm },
  emptyLabel: { fontSize: 13, color: color.mute, textAlign: 'center' },

  list: {
    maxHeight: 240,
    marginHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    marginBottom: space.md,
  },
  threadRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingVertical: 12 },
  threadRowSelected: { backgroundColor: color.signal + '0A' },
  threadName: { fontSize: 14, fontWeight: '700', color: color.ink },
  threadNameSelected: { color: color.signalStrong },
  threadSub: { fontSize: 11, color: color.mute, marginTop: 1 },
  checkBadge: { width: icon.s20, height: icon.s20, borderRadius: icon.s20 / 2, backgroundColor: color.signalStrong, alignItems: 'center', justifyContent: 'center' },
  checkText: { fontSize: 12, color: color.onInk, fontWeight: '700' },

  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    backgroundColor: color.signalStrong,
    borderRadius: radius.md,
    paddingVertical: 14,
  },
  sendBtnDisabled: { opacity: 0.45 },
  sendLabel: { fontSize: 15, fontWeight: '700', color: color.onInk },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: color.ink,
    padding: 0,
  },
  peopleDividerRow: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    backgroundColor: color.paper,
  },
  peopleDividerText: {
    fontSize: 10,
    fontFamily: 'Courier',
    fontWeight: '700',
    color: color.mute,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
  },

  startChatBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: color.signal + '15',
    borderWidth: 1,
    borderColor: color.signal + '40',
  },
  startChatText: { fontSize: 12, fontWeight: '700', color: color.signalStrong },
});
