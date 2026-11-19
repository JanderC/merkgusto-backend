/**
 * Conexión de WhatsApp (Baileys) integrada al backend.
 * Basado en el servicio probado de PowerZone: reconexión con backoff, limpieza
 * de sesión al cerrar remotamente, acumulador de ráfagas y cola de envío.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Boom } from '@hapi/boom';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, type WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode';
import { STORAGE_DIR } from '../../config/env.js';
import { db } from '../../db/index.js';
import { normalizarTelefono, sleep } from '../../lib/util.js';

const SESSION_DIR = path.join(STORAGE_DIR, 'whatsapp-session');
const MAX_RECONEXIONES = 6;
const RAFAGA_MS = 4000; // agrupa mensajes seguidos y responde una sola vez

export type EstadoWa = 'apagado' | 'conectando' | 'qr' | 'conectado';
type Tipo = 'chat' | 'bot' | 'reporte' | 'aviso' | 'manual';
export type ManejadorEntrante = (m: { jid: string; telefono: string | null; nombre: string | null; texto: string }) => Promise<string | null>;

class WhatsAppService {
  private sock: WASocket | null = null;
  private estado: EstadoWa = 'apagado';
  private qr: string | null = null;
  private telefono: string | null = null;
  private reconexiones = 0;
  private cerrandoManual = false;
  private ultimoError: string | null = null;
  private rafagas = new Map<string, { timer: NodeJS.Timeout; textos: string[]; nombre: string | null; telefono: string | null }>();
  private vistos = new Set<string>();
  private colaEnvio: Promise<unknown> = Promise.resolve();
  manejador: ManejadorEntrante | null = null;
  onConectado: (() => void) | null = null;

  getEstado() {
    return { estado: this.estado, qr: this.qr, telefono: this.telefono, ultimoError: this.ultimoError, tieneSesion: this.tieneSesion() };
  }

  get conectado() {
    return this.estado === 'conectado';
  }

  tieneSesion() {
    return fs.existsSync(path.join(SESSION_DIR, 'creds.json'));
  }

  async iniciar(): Promise<void> {
    if (this.estado === 'conectando' || this.estado === 'conectado' || this.estado === 'qr') return;
    this.estado = 'conectando';
    this.cerrandoManual = false;
    try {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
      const sock = makeWASocket({
        ...(version && { version }),
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['Windows', 'Chrome', '120.0.0'],
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: false,
      });
      this.sock = sock;
      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (u) => {
        if (u.qr) {
          this.estado = 'qr';
          this.qr = await qrcode.toDataURL(u.qr, { width: 320, margin: 1 });
        }
        if (u.connection === 'open') {
          this.estado = 'conectado';
          this.qr = null;
          this.reconexiones = 0;
          this.ultimoError = null;
          this.telefono = sock.user?.id?.split(':')[0]?.split('@')[0] ?? null;
          console.log(`✅ [WhatsApp] Conectado como ${this.telefono}`);
          this.onConectado?.();
        }
        if (u.connection === 'close') {
          this.estado = 'apagado';
          this.qr = null;
          this.sock = null;
          const code = new Boom(u.lastDisconnect?.error).output?.statusCode;
          this.ultimoError = `Desconectado (código ${code ?? '?'})`;
          if (this.cerrandoManual) return;
          if (code === DisconnectReason.loggedOut) {
            console.log('🚪 [WhatsApp] Sesión cerrada desde el teléfono. Hay que escanear de nuevo.');
            this.borrarSesion();
            return;
          }
          if (this.reconexiones < MAX_RECONEXIONES) {
            this.reconexiones++;
            const espera = Math.min(2 ** this.reconexiones * 3, 120);
            console.log(`🔄 [WhatsApp] Reconectando (${this.reconexiones}/${MAX_RECONEXIONES}) en ${espera}s…`);
            await sleep(espera * 1000);
            void this.iniciar();
          } else {
            console.log('❌ [WhatsApp] No se pudo reconectar. Reintenta desde el panel.');
          }
        }
      });

      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          try {
            const jid = msg.key.remoteJid ?? '';
            if (msg.key.fromMe || !jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
            const id = msg.key.id ?? '';
            if (this.vistos.has(id)) continue;
            this.vistos.add(id);
            setTimeout(() => this.vistos.delete(id), 10 * 60_000).unref();
            const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
            if (!texto.trim()) continue;
            // Con los nuevos identificadores @lid el número real viene en remoteJidAlt / senderPn
            const k = msg.key as typeof msg.key & { remoteJidAlt?: string; senderPn?: string };
            const pnJid = [jid, k.remoteJidAlt, k.senderPn].find((j) => j?.endsWith('@s.whatsapp.net'));
            const telefono = pnJid ? pnJid.split('@')[0]!.split(':')[0]! : null;
            void this.log('entrante', jid, texto, 'chat', msg.pushName ?? null);
            this.acumular(jid, texto, msg.pushName ?? null, telefono);
          } catch (e) {
            console.error('✗ [WhatsApp] Error leyendo mensaje:', (e as Error).message);
          }
        }
      });
    } catch (e) {
      this.estado = 'apagado';
      this.ultimoError = (e as Error).message;
      console.error('✗ [WhatsApp] No se pudo iniciar:', this.ultimoError);
    }
  }

  private acumular(jid: string, texto: string, nombre: string | null, telefono: string | null) {
    const prev = this.rafagas.get(jid);
    if (prev) clearTimeout(prev.timer);
    const entry = { textos: [...(prev?.textos ?? []), texto], nombre, telefono, timer: undefined as unknown as NodeJS.Timeout };
    entry.timer = setTimeout(async () => {
      this.rafagas.delete(jid);
      if (!this.manejador) return;
      try {
        const respuesta = await this.manejador({ jid, telefono, nombre, texto: entry.textos.join('\n') });
        if (respuesta) await this.enviarJid(jid, respuesta, 'bot', true);
      } catch (e) {
        console.error('✗ [WhatsApp] Error respondiendo:', (e as Error).message);
      }
    }, RAFAGA_MS);
    this.rafagas.set(jid, entry);
  }

  /** Envía a un número (cualquier formato local o internacional). */
  async enviar(numero: string, texto: string, tipo: Tipo = 'manual') {
    const n = normalizarTelefono(numero);
    if (!n) throw new Error('Número inválido');
    return this.enviarJid(`${n}@s.whatsapp.net`, texto, tipo, false);
  }

  /** Cola secuencial con pausas: evita ráfagas que WhatsApp marca como spam. */
  private enviarJid(jid: string, texto: string, tipo: Tipo, escribiendo: boolean) {
    const tarea = this.colaEnvio.then(async () => {
      if (!this.sock || !this.conectado) throw new Error('WhatsApp no está conectado');
      let destino = jid;
      if (jid.endsWith('@s.whatsapp.net')) {
        const [r] = (await this.sock.onWhatsApp(jid.split('@')[0]!).catch(() => [])) ?? [];
        if (r && !r.exists) throw new Error(`El número ${jid.split('@')[0]} no tiene WhatsApp`);
        if (r?.jid) destino = r.jid;
      }
      if (escribiendo) {
        await this.sock.sendPresenceUpdate('composing', destino).catch(() => undefined);
        await sleep(Math.min(800 + texto.length * 15, 3500));
        await this.sock.sendPresenceUpdate('paused', destino).catch(() => undefined);
      }
      await this.sock.sendMessage(destino, { text: texto });
      await this.log('saliente', destino, texto, tipo, null);
      await sleep(1200 + Math.random() * 1500);
    });
    this.colaEnvio = tarea.catch(() => undefined);
    return tarea;
  }

  async desconectar() {
    this.cerrandoManual = true;
    try {
      await this.sock?.logout();
    } catch {
      /* ya estaba cerrada */
    }
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignorar */
    }
    this.sock = null;
    this.estado = 'apagado';
    this.qr = null;
    this.telefono = null;
    this.borrarSesion();
  }

  private borrarSesion() {
    try {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    } catch (e) {
      console.error('✗ [WhatsApp] No se pudo borrar la sesión:', (e as Error).message);
    }
  }

  private async log(direccion: 'entrante' | 'saliente', jid: string, texto: string, tipo: Tipo, nombre: string | null) {
    await db
      .insertInto('waMensajes')
      .values({ direccion, jid, texto: texto.slice(0, 4000), tipo, nombre })
      .execute()
      .catch((e) => console.error('✗ [WhatsApp] No se pudo guardar el mensaje:', e.message));
  }
}

export const whatsapp = new WhatsAppService();
