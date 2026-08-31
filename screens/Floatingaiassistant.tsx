/**
 * FloatingAIAssistant.tsx
 * Exact clone of web `FloatingAICommandAssistant` (vishful-mobile-app.vercel.app).
 * - Round primary FAB, MessageSquare icon → toggles to X when open (no pulse).
 * - Floating card panel above the FAB (not a full-screen modal): "AI Command"
 *   header (Bot + Sparkles + X), rounded-2xl bubbles, Textarea + Mic + Send row.
 * - Voice mic is web-functional (Web Speech API) and disabled on native, exactly
 *   like the reference gates it via `voiceSupported`.
 * Keeps the existing Q&A backend: convex/aiAssistant.ts → Groq / Gemini.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform,
  Dimensions,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useAuth } from '../lib/auth';
import { client as convexClient, api as convexApi } from '../lib/convexApi';

// ─── Reference palette (mobile theme, aligned to the vercel reference) ─────────
const C = {
  primary:      '#6A2C90',   // --primary (277 53% 37%) — reference purple
  primaryFg:    '#FFFFFF',   // --primary-foreground
  muted:        '#F1F5F9',   // --muted
  mutedFg:      '#64748B',   // --muted-foreground
  background:   'rgba(255,255,255,0.97)', // --background/95 + backdrop-blur
  foreground:   '#0F172A',   // --foreground
  border:       '#E5E7EB',   // --border
  mutedHeader:  'rgba(241,245,249,0.5)',  // bg-muted/40
  destructive:  '#EF4444',   // --destructive
};

// ─── Types ────────────────────────────────────────────────────────────────────
type Message = { role: 'user' | 'assistant'; content: string };

// ─── Simple markdown renderer (bold, bullet lists) ────────────────────────────
function MarkdownText({ text, style }: { text: string; style?: any }) {
  const lines = text.split('\n');
  return (
    <View>
      {lines.map((line, i) => {
        const isBullet = /^[\*\-•]\s/.test(line.trim());
        const clean = line.trim().replace(/^[\*\-•]\s/, '');
        const parts = clean.split(/\*\*(.*?)\*\*/g);
        return (
          <View key={i} style={isBullet ? { flexDirection: 'row', marginBottom: 2 } : { marginBottom: 1 }}>
            {isBullet && <Text style={[style, { marginRight: 6 }]}>•</Text>}
            <Text style={[style, { flex: 1, flexWrap: 'wrap' }]}>
              {parts.map((p, j) =>
                j % 2 === 1
                  ? <Text key={j} style={{ fontWeight: '800' }}>{p}</Text>
                  : <Text key={j}>{p}</Text>
              )}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ─── Message bubble (rounded-2xl, primary user / muted assistant) ──────────────
function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user';
  return (
    <View style={[S.row, isUser ? S.rowEnd : S.rowStart]}>
      <View style={[S.bubble, isUser ? S.bubbleUser : S.bubbleBot]}>
        {isUser
          ? <Text style={S.bubbleTextUser}>{msg.content}</Text>
          : <MarkdownText text={msg.content} style={S.bubbleTextBot} />
        }
      </View>
    </View>
  );
}

// ─── Web Speech API helper (web only) ─────────────────────────────────────────
function getSpeechRecognitionCtor(): any {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function FloatingAIAssistant({ raised }: { raised?: boolean }) {
  const { user } = useAuth();
  const [open, setOpen]         = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput]       = useState('');
  const [busy, setBusy]         = useState(false);
  const [listening, setListening] = useState(false);
  const scrollRef               = useRef<ScrollView>(null);
  const recognitionRef          = useRef<any>(null);
  const voiceBaseRef            = useRef('');

  const voiceSupported = Boolean(getSpeechRecognitionCtor());

  // Auto-scroll to bottom on new message
  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [messages, busy]);

  // Greet on first open
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{
        role: 'assistant',
        content: `Hi! I'm your Vishful AI assistant. I have access to your live data — tenants, tickets, properties, EB payments and more.\n\nAsk me anything about your organization!`,
      }]);
    }
  }, [open]);

  // Stop voice when the panel closes / on unmount
  const stopVoice = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
    recognitionRef.current = null;
    setListening(false);
  }, []);

  useEffect(() => { if (!open) stopVoice(); }, [open, stopVoice]);
  useEffect(() => () => stopVoice(), [stopVoice]);

  const toggleVoice = useCallback(() => {
    if (!voiceSupported || busy) return;
    if (listening) { stopVoice(); return; }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    voiceBaseRef.current = input.trim();
    const rec = new Ctor();
    recognitionRef.current = rec;
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (event: any) => {
      let finalPart = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) finalPart += r[0].transcript;
        else interim += r[0].transcript;
      }
      const raw = [voiceBaseRef.current, finalPart.trim(), interim.trim()].filter(Boolean).join(' ').trim();
      setInput(raw);
    };
    rec.onerror = (e: any) => { if (e?.error !== 'aborted' && e?.error !== 'no-speech') stopVoice(); };
    rec.onend = () => { recognitionRef.current = null; setListening(false); };
    try { setListening(true); rec.start(); } catch { setListening(false); recognitionRef.current = null; }
  }, [voiceSupported, busy, listening, input, stopVoice]);

  const handleSend = async (text?: string) => {
    const q = (text || input).trim();
    if (!q || busy) return;
    stopVoice();
    setInput('');
    const newHistory: Message[] = [...messages, { role: 'user', content: q }];
    setMessages(newHistory);
    setBusy(true);
    try {
      const res = await convexClient.action(
        (convexApi as any).aiAssistant.askAssistant,
        {
          question: q,
          history: newHistory.slice(-6).map(m => ({ role: m.role, content: m.content })),
        }
      );
      setMessages(prev => [...prev, { role: 'assistant', content: res.answer || 'No response.' }]);
    } catch (e: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message || 'Could not reach AI.'}` }]);
    }
    setBusy(false);
  };

  // Only show for admin / employee roles (not tenant) — mirrors FLOATING_AI_ASSISTANT_ROLES
  const role = (user as any)?.role || (user as any)?.userType || '';
  if (role === 'tenant') return null;

  const canSend = Boolean(input.trim()) && !busy;

  return (
    <View style={[S.container, { bottom: raised ? 88 : 28 }]} pointerEvents="box-none">
      {/* ── Floating Card panel (above the FAB) ─────────────────────────────── */}
      {open && (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={S.cardWrap}
          pointerEvents="box-none"
        >
          <View style={S.card}>
            {/* Header */}
            <View style={S.header}>
              <View style={S.headerLeft}>
                <MaterialCommunityIcons name="robot-outline" size={17} color={C.primary} />
                <Text style={S.headerTitle}>AI Command</Text>
                <Ionicons name="sparkles" size={13} color={C.mutedFg} />
              </View>
              <TouchableOpacity onPress={() => setOpen(false)} style={S.ghostBtn} accessibilityLabel="Close assistant">
                <Ionicons name="close" size={18} color={C.foreground} />
              </TouchableOpacity>
            </View>

            {/* Messages */}
            <ScrollView
              ref={scrollRef}
              style={S.messages}
              contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)}

              {busy && (
                <View style={S.working}>
                  <ActivityIndicator size="small" color={C.mutedFg} />
                  <Text style={S.workingText}>Working…</Text>
                </View>
              )}
            </ScrollView>

            {/* Input row: Textarea + Mic + Send */}
            <View style={S.inputRow}>
              <TextInput
                style={S.textInput}
                value={input}
                onChangeText={setInput}
                placeholder={listening ? 'Listening…' : 'Ask AI anything…'}
                placeholderTextColor={C.mutedFg}
                multiline
                maxLength={500}
                editable={!busy}
                onSubmitEditing={() => handleSend()}
                returnKeyType="send"
                blurOnSubmit
                textAlignVertical="top"
              />
              <TouchableOpacity
                onPress={toggleVoice}
                disabled={busy || !voiceSupported}
                style={[
                  S.iconBtnOutline,
                  listening && S.iconBtnDanger,
                  (busy || !voiceSupported) && { opacity: 0.4 },
                ]}
                accessibilityLabel={listening ? 'Stop voice input' : 'Start voice input'}
              >
                <Ionicons name="mic" size={17} color={listening ? C.primaryFg : C.foreground} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleSend()}
                disabled={!canSend}
                style={[S.iconBtnPrimary, !canSend && { opacity: 0.4 }]}
                accessibilityLabel="Send"
              >
                <Ionicons name="send" size={16} color={C.primaryFg} />
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* ── Floating Action Button ──────────────────────────────────────────── */}
      <TouchableOpacity
        onPress={() => setOpen(o => !o)}
        style={S.fab}
        activeOpacity={0.85}
        accessibilityLabel={open ? 'Close AI command assistant' : 'Open AI command assistant'}
      >
        {open
          ? <Ionicons name="close" size={22} color={C.primaryFg} />
          : <MaterialCommunityIcons name="message-text" size={20} color={C.primaryFg} />
        }
      </TouchableOpacity>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const { width: W, height: H } = Dimensions.get('window');
const CARD_W = Math.min(W - 32, 400);
const CARD_H = Math.min(H * 0.85, 560);

const S = StyleSheet.create({
  // Container — anchored bottom-right, stacks card above FAB (gap 8)
  container: {
    position: 'absolute',
    right: 20,    // reference: max-md:right-5
    alignItems: 'flex-end',
    zIndex: 100,
  },
  cardWrap: { marginBottom: 8 },

  // FAB — h-11 w-11 rounded-full shadow-md, primary
  fab: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: C.primary,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#0F172A', shadowOpacity: 0.18, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }, elevation: 6,
  },

  // Card — w:min(100vw-2rem,400) h:min(85vh,560), rounded, border, blur bg
  card: {
    width: CARD_W, height: CARD_H,
    backgroundColor: C.background,
    borderRadius: 16, borderWidth: 1, borderColor: C.border,
    overflow: 'hidden',
    shadowColor: '#0F172A', shadowOpacity: 0.14, shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 }, elevation: 12,
  },

  // Header — px-3 py-2 border-b bg-muted/40
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: C.border,
    backgroundColor: C.mutedHeader,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerTitle: { fontSize: 14, fontWeight: '600', color: C.foreground },
  ghostBtn: {
    width: 32, height: 32, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },

  // Messages
  messages: { flex: 1 },
  row: { flexDirection: 'row', marginBottom: 12 },
  rowEnd: { justifyContent: 'flex-end' },
  rowStart: { justifyContent: 'flex-start' },
  bubble: { maxWidth: CARD_W * 0.9, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  bubbleUser: { backgroundColor: C.primary, borderBottomRightRadius: 6 },
  bubbleBot:  { backgroundColor: C.muted, borderBottomLeftRadius: 6 },
  bubbleTextUser: { fontSize: 14, color: C.primaryFg, lineHeight: 20 },
  bubbleTextBot:  { fontSize: 14, color: C.foreground, lineHeight: 20 },

  // Working…
  working: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, paddingVertical: 2 },
  workingText: { fontSize: 12, color: C.mutedFg },

  // Input row — p-2 border-t
  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    padding: 8, borderTopWidth: 1, borderTopColor: C.border,
    backgroundColor: C.background,
  },
  textInput: {
    flex: 1, minHeight: 44, maxHeight: 160,
    backgroundColor: '#FFFFFF',
    borderWidth: 1, borderColor: C.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, color: C.foreground,
  },
  iconBtnOutline: {
    width: 40, height: 40, borderRadius: 10,
    borderWidth: 1, borderColor: C.border, backgroundColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center',
  },
  iconBtnDanger: { backgroundColor: C.destructive, borderColor: C.destructive },
  iconBtnPrimary: {
    width: 40, height: 40, borderRadius: 10,
    backgroundColor: C.primary,
    alignItems: 'center', justifyContent: 'center',
  },
});
