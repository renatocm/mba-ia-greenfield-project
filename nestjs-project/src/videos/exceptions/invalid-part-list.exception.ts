import { BadRequestException } from '@nestjs/common';

export class InvalidPartListException extends BadRequestException {
  constructor() {
    super({
      statusCode: 400,
      error: 'UPLOAD_PARTS_INVALID',
      message: 'Lista de partes do upload inválida.',
    });
  }
}
