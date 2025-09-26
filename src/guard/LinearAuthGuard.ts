import * as crypto from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class LinearAuthGuard implements CanActivate {
  private verifySignature(headerSignature: string, rawBody: Buffer, secret: string) {
    if (typeof headerSignature !== 'string') return false;

    const header = Buffer.from(headerSignature, 'hex');
    const computed = crypto.createHmac('sha256', secret).update(new Uint8Array(rawBody)).digest();

    return crypto.timingSafeEqual(new Uint8Array(computed), new Uint8Array(header));
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();

    const signature = req.headers['linear-signature'];
    const rawBody = req.rawBody as Buffer;
    const secret = process.env.LINEAR_SIGNING_SECRETS;

    if (!secret) {
      throw new UnauthorizedException('LINEAR_WEBHOOK_SECRET not set');
    }

    if (!this.verifySignature(signature, rawBody, secret)) {
      throw new UnauthorizedException('Invalid Linear signature');
    }

    const timestamp = Number(req.body?.webhookTimestamp);
    if (!Number.isFinite(timestamp)) {
      throw new UnauthorizedException('Missing or invalid webhook timestamp');
    }

    if (Math.abs(Date.now() - timestamp) > 60_000) {
      throw new UnauthorizedException('Stale webhook (possible replay attack)');
    }

    return true;
  }
}
