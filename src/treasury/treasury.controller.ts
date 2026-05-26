import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TreasuryClientGuard } from './treasury-client.guard';
import { TreasuryService, MovementRow, PositionSnapshot } from './treasury.service';
import { InsufficientPrincipalError, InvalidAmountError } from './treasury.errors';

interface MutateBody {
  amount_usdc_units?: string;
  idempotency_key?: string;
}

interface MovementResponse {
  id: string;
  direction: string;
  amount_usdc_units: string;
  provider: string;
  external_ref: string | null;
  running_balance_units: string;
  created_at: string;
}

interface PositionResponse {
  provider: string;
  principal_units: string;
  yield_earned_units: string;
  last_synced_at: string;
}

@Controller('api/treasury')
@UseGuards(TreasuryClientGuard)
export class TreasuryController {
  constructor(private readonly treasury: TreasuryService) {}

  @Post('deposit')
  @HttpCode(200)
  async deposit(@Body() body: MutateBody): Promise<MovementResponse> {
    const { amount, idempotencyKey } = this.parseMutateBody(body);
    try {
      const row = await this.treasury.deposit(amount, idempotencyKey);
      return this.serialiseMovement(row);
    } catch (err) {
      this.translate(err);
    }
  }

  @Post('withdraw')
  @HttpCode(200)
  async withdraw(@Body() body: MutateBody): Promise<MovementResponse> {
    const { amount, idempotencyKey } = this.parseMutateBody(body);
    try {
      const row = await this.treasury.withdraw(amount, idempotencyKey);
      return this.serialiseMovement(row);
    } catch (err) {
      this.translate(err);
    }
  }

  @Get('position')
  async position(): Promise<PositionResponse> {
    const snap = await this.treasury.getPosition();
    return this.serialisePosition(snap);
  }

  @Get('yield-earned')
  async yieldEarned(): Promise<{ provider: string; yield_earned_units: string }> {
    const snap = await this.treasury.getPosition();
    return {
      provider: snap.provider,
      yield_earned_units: snap.yieldEarnedUnits.toString(),
    };
  }

  private parseMutateBody(body: MutateBody): { amount: bigint; idempotencyKey: string } {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('body required');
    }
    if (typeof body.amount_usdc_units !== 'string' || body.amount_usdc_units.length === 0) {
      throw new BadRequestException('amount_usdc_units (string) required');
    }
    if (typeof body.idempotency_key !== 'string' || body.idempotency_key.length === 0) {
      throw new BadRequestException('idempotency_key (string) required');
    }
    let amount: bigint;
    try {
      amount = BigInt(body.amount_usdc_units);
    } catch {
      throw new BadRequestException('amount_usdc_units must be a base-10 integer string');
    }
    if (amount <= 0n) throw new BadRequestException('amount_usdc_units must be > 0');
    return { amount, idempotencyKey: body.idempotency_key };
  }

  private serialiseMovement(row: MovementRow): MovementResponse {
    return {
      id: row.id,
      direction: row.direction,
      amount_usdc_units: row.amountUnits.toString(),
      provider: row.provider,
      external_ref: row.externalRef,
      running_balance_units: row.runningBalanceUnits.toString(),
      created_at: row.createdAt.toISOString(),
    };
  }

  private serialisePosition(snap: PositionSnapshot): PositionResponse {
    return {
      provider: snap.provider,
      principal_units: snap.principalUnits.toString(),
      yield_earned_units: snap.yieldEarnedUnits.toString(),
      last_synced_at: snap.lastSyncedAt.toISOString(),
    };
  }

  private translate(err: unknown): never {
    if (err instanceof InvalidAmountError) throw new BadRequestException(err.message);
    if (err instanceof InsufficientPrincipalError) {
      throw new BadRequestException(err.message);
    }
    throw err;
  }
}
