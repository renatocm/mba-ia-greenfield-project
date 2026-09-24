import { BadGatewayException } from '@nestjs/common';

export class StorageException extends BadGatewayException {
  constructor(cause?: unknown) {
    super({
      statusCode: 502,
      error: 'STORAGE_REQUEST_FAILED',
      message: 'Não foi possível falar com o storage.',
    });

    this.cause = cause;
  }
}
