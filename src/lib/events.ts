import { EventEmitter } from 'node:events';

/** Bus interno para desacoplar módulos (caja → WhatsApp, etc.). */
interface Eventos {
  'turno:cerrado': { turnoId: string };
}

class Bus extends EventEmitter {
  emitir<K extends keyof Eventos>(evento: K, data: Eventos[K]) {
    // Nunca dejamos que un suscriptor rompa al emisor
    setImmediate(() => {
      try {
        this.emit(evento, data);
      } catch (e) {
        console.error(`✗ Error en suscriptor de ${evento}:`, (e as Error).message);
      }
    });
  }
  al<K extends keyof Eventos>(evento: K, fn: (data: Eventos[K]) => void | Promise<void>) {
    this.on(evento, (d: Eventos[K]) => {
      Promise.resolve(fn(d)).catch((e) => console.error(`✗ Error en suscriptor de ${evento}:`, (e as Error).message));
    });
  }
}

export const bus = new Bus();
