import { ForbiddenException } from '@nestjs/common';

export class VideoAccessDeniedException extends ForbiddenException {
  constructor() {
    super({
      statusCode: 403,
      error: 'VIDEO_ACCESS_DENIED',
      message: 'Você não tem acesso a este vídeo.',
    });
  }
}
