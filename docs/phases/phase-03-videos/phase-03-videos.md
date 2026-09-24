---
title: Phase 03 — Upload e Processamento de Vídeos
phase: 03
status: ready-for-implement
mtime: "2026-09-23T19:55:07.833-03:00"
sources:
  - docs/decisions/technical-decisions-phase-03-videos.md
  - docs/phases/phase-03-videos/context.md
  - docs/phases/phase-03-videos/library-refs.md
  - docs/phases/phase-03-videos/validation.md
  - docs/project-plan.md
  - CLAUDE.md
  - .claude/rules/nestjs-controllers.md
---

# Phase 03 — Plano Executável Final

Base validada como **clean** e sem findings abertos; este plano consolida somente backend (`nestjs-project/`) e mantém frontend/visibilidade editorial fora do escopo desta fase. [Sources: docs/phases/phase-03-videos/validation.md:16-25; docs/phases/phase-03-videos/context.md:24-46; docs/project-plan.md:67-83]

## 1. Step Implementations (SIs)

### SI-03.1 — Persistência base do agregado Video
- **Objetivo:** criar a persistência mínima da fase: tabela `videos`, enum `draft|processing|ready|error`, `publicId`, ownership, storage keys e as 4 colunas operacionais de falha/tentativa. [Sources: technical-decisions-phase-03-videos.md:450-488; context.md:315-335]
- **Arquivos/Componentes afetados:** `nestjs-project/src/videos/entities/video.entity.ts`; `src/videos/video-status.enum.ts`; `src/database/migrations/*CreateVideos*.ts`; `src/channels/entities/channel.entity.ts`; `src/users/entities/user.entity.ts`; `src/videos/videos.module.ts`. [Sources: context.md:198-199,315-335; CLAUDE.md:42-57]
- **Dependências:** nenhuma.
- **Implementation Steps:** modelar `Video` com FK para `channels` e `users`; definir índices em `public_id`, `channel_id`, `status`; persistir `draft_created_at`, `upload_session_id`, `upload_completed_at`, `processing_started_at`, `processing_completed_at`, `metadata_json`, `processing_attempts`, `last_error`, `last_error_at`, `last_error_stack_trace`; revisar `down()` reversível. [Sources: technical-decisions-phase-03-videos.md:337-342,456-486; context.md:317-335]
- **Acceptance Criteria:** migration cria `videos` + índices; `status` default é `draft`; `public_id` é único; não existe tabela separada para tentativas. [Sources: technical-decisions-phase-03-videos.md:448-488; validation.md:38-40]
- **Testes Obrigatórios:** integração da entity; integração de migration runner; compilação do módulo. [Sources: CLAUDE.md:48-57,70-72; context.md:202-207,337-355]
- **Critério de Conclusão:** migration roda/reverte com sucesso e a suíte de persistência prova constraints, defaults e relações.

### SI-03.2 — Serviço de domínio de vídeos e contratos básicos
- **Objetivo:** criar o núcleo do módulo `videos` para draft lifecycle, leitura por `publicId`, autorização de ownership e serialização do status externo. [Sources: technical-decisions-phase-03-videos.md:150-163,328-344,450-488; context.md:102-114]
- **Arquivos/Componentes afetados:** `src/videos/videos.module.ts`; `src/videos/videos.service.ts`; `src/videos/videos.controller.ts`; `src/videos/dto/*`; `src/videos/repositories/*` (se necessário); `src/app.module.ts`. [Sources: context.md:198-205,259-270; CLAUDE.md:42-46]
- **Dependências:** SI-03.1.
- **Implementation Steps:** expor operações para criar draft, buscar vídeo por `publicId`, validar se o usuário autenticado é dono do canal/vídeo, traduzir estado interno para contrato público e manter controller fino com DTOs e OpenAPI. [Sources: context.md:102-105,196-205,259-270; .claude/rules/nestjs-controllers.md:27-39,50-89]
- **Acceptance Criteria:** serviços retornam o mesmo envelope público para `status/error_message`; lookup público usa `publicId`; controllers seguem pluralização, Bearer auth e envelope de erro compartilhado. [Sources: technical-decisions-phase-03-videos.md:452-486; .claude/rules/nestjs-controllers.md:29-35,52-89]
- **Testes Obrigatórios:** unit para regras de ownership/branching; integração para queries/relations; e2e para DTO/guard/envelope HTTP. [Sources: CLAUDE.md:48-57; context.md:202-207]
- **Critério de Conclusão:** módulo compila, endpoints básicos documentados funcionam e nenhuma regra de domínio fica em controller/guard.

### SI-03.3 — Upload multipart e draft orchestration
- **Objetivo:** implementar `POST /videos/upload-session`, `POST /videos/upload-session/complete`, `GET /videos/upload-session/:videoId/parts` e `DELETE /videos/upload-session/:videoId`, sem proxy do binário. [Sources: technical-decisions-phase-03-videos.md:108-120,148-163; context.md:117-129,259-270; library-refs.md:215-317,336-399]
- **Arquivos/Componentes afetados:** `src/videos/videos.controller.ts`; `src/videos/videos.service.ts`; `src/videos/storage/s3.service.ts`; `src/videos/dto/upload-session*.ts`; `src/config/*storage*.ts` ou namespace equivalente; `src/common/*` apenas se reaproveitar DTO/envelope existente. [Sources: context.md:179-194,216-241,259-270]
- **Dependências:** SI-03.1, SI-03.2.
- **Implementation Steps:** criar draft antes da sessão multipart; gerar `CreateMultipartUpload`; emitir URLs presignadas de `UploadPart`; expor `ListParts` para retomada; concluir multipart recebendo pares `PartNumber/ETag`; abortar sessão e disparar cleanup lógico do draft quando aplicável; manter expiração de 1h. [Sources: technical-decisions-phase-03-videos.md:148-163; library-refs.md:217-317,336-399,429-432]
- **Acceptance Criteria:** upload suporta retomada por parte; `UploadId` e `upload_session_id` ficam correlacionados; `complete` marca `upload_completed_at` e publica processamento; `abort` invalida a sessão sem a API receber bytes. [Sources: context.md:117-129,297-304; library-refs.md:171-187,282-317]
- **Testes Obrigatórios:** unit para serviço de storage; integração para persistência da sessão; e2e cobrindo iniciar/listar/concluir/abortar. [Sources: CLAUDE.md:48-57; context.md:341-355]
- **Critério de Conclusão:** um cliente consegue subir um arquivo de forma multipart presignada até o `complete`, com draft rastreável e sem tráfego binário pela API.

### SI-03.4 — Infra de fila, Redis e bootstrap do worker
- **Objetivo:** preparar Redis, BullMQ e o bootstrap isolado do worker em container/processo separado. [Sources: technical-decisions-phase-03-videos.md:54-76,190-209,512-557; context.md:151-156,216-241,272-284]
- **Arquivos/Componentes afetados:** `nestjs-project/compose.yaml`; `nestjs-project/Dockerfile.worker` ou build equivalente; `src/videos/queue/*`; `src/video-worker/main.ts`; `src/app.module.ts`; `.env.example`; documentação operacional da phase. [Sources: context.md:174-194,216-241; CLAUDE.md:17-38]
- **Dependências:** SI-03.1.
- **Implementation Steps:** registrar `BullModule`/queue `video-processing`; configurar `REDIS_URL=redis://redis:6379`; criar entry point do worker com DI próprio; instalar FFmpeg/ffprobe na imagem do worker; adicionar healthcheck separado para API e worker; manter `concurrency=2`. [Sources: technical-decisions-phase-03-videos.md:56-63,200-207; library-refs.md:48-95,133-169,492-505]
- **Acceptance Criteria:** API publica jobs na queue correta; worker sobe em container distinto; Redis é acessado por nome de serviço Docker; healthcheck evidencia indisponibilidade separadamente. [Sources: technical-decisions-phase-03-videos.md:190-209; CLAUDE.md:29-38]
- **Testes Obrigatórios:** unit de módulo/DI para queue wiring; integração de bootstrap com Redis real quando aplicável. [Sources: context.md:202-207,337-355]
- **Critério de Conclusão:** infraestrutura sobe com API + Redis + worker, e um job de teste chega à fila correta.

### SI-03.5 — Lógica de processamento do worker
- **Objetivo:** consumir `video.process.requested`, executar `ffprobe`/FFmpeg, persistir metadata/thumbnail e aplicar retry/idempotência. [Sources: technical-decisions-phase-03-videos.md:239-253,468-486,514-557; library-refs.md:128-188,438-505]
- **Arquivos/Componentes afetados:** `src/videos/worker/video.processor.ts`; `src/videos/worker/video-processing.service.ts`; `src/videos/storage/s3.service.ts`; `src/videos/contracts/video-process-requested.ts`; `src/videos/utils/ffprobe.util.ts`; `src/videos/utils/thumbnail.util.ts`. [Sources: context.md:272-314]
- **Dependências:** SI-03.1, SI-03.4.
- **Implementation Steps:** usar `jobId=video-${videoId}`; executar preflight `SELECT id,status`; mover `draft→processing`; baixar/ler objeto original; persistir `metadata_json` logo após `ffprobe`; gerar thumbnail em ~25% da duração; gravar `processing_attempts` e última falha; promover para `ready` sem thumbnail após 5 falhas da etapa de imagem. [Sources: technical-decisions-phase-03-videos.md:239-250,468-486,514-555; library-refs.md:171-187,440-456,494-505]
- **Acceptance Criteria:** `ready` nunca roda duas vezes em paralelo para o mesmo vídeo; falha de `ffprobe` termina em `error`; falha apenas de thumbnail preserva metadata e pode concluir `ready` com `thumbnail_url` nulo. [Sources: technical-decisions-phase-03-videos.md:247-250,473-476,532-555; library-refs.md:440-456]
- **Testes Obrigatórios:** unit para parser/branching; integração com DB + queue + storage fake/real; teste do worker contra Redis real. [Sources: CLAUDE.md:48-57; context.md:341-355]
- **Critério de Conclusão:** worker processa um job canônico fim a fim, com retries observáveis e idempotência comprovada.

### SI-03.6 — Endpoints de streaming e download
- **Objetivo:** implementar `GET /videos/{publicId}/stream` e `GET /videos/{publicId}/download` retornando URLs assinadas, nunca bytes do vídeo. [Sources: technical-decisions-phase-03-videos.md:372-424; context.md:144-147,242-248,265-269; library-refs.md:401-436]
- **Arquivos/Componentes afetados:** `src/videos/videos.controller.ts`; `src/videos/videos.service.ts`; `src/videos/storage/s3.service.ts`; `src/videos/dto/stream-download-response.dto.ts`; OpenAPI do módulo. [Sources: context.md:259-270; .claude/rules/nestjs-controllers.md:36-89]
- **Dependências:** SI-03.2, SI-03.3, SI-03.5.
- **Implementation Steps:** validar acesso por `publicId` e `status`; emitir `GetObject` presignado de 30min para stream e 24h para download com `Content-Disposition`; manter bucket privado `videos-originals`; documentar que `Range/206` é servido pelo storage. [Sources: technical-decisions-phase-03-videos.md:374-424; library-refs.md:401-436]
- **Acceptance Criteria:** endpoints devolvem URL temporária válida; API não faz proxy; clientes podem usar `Range` para streaming progressivo; download força anexo. [Sources: technical-decisions-phase-03-videos.md:374-424; project-plan.md:79-83,165-169]
- **Testes Obrigatórios:** unit para regras de autorização/status; e2e para contrato HTTP; integração para assinatura S3/MinIO. [Sources: context.md:341-355]
- **Critério de Conclusão:** vídeo `ready` fica acessível por URL assinada de stream/download sem regressão do envelope HTTP.

### SI-03.7 — Listagem de vídeos por canal
- **Objetivo:** implementar `GET /channels/{channelId}/videos` como sub-resource REST, cobrindo painel e futuras páginas públicas sem antecipar frontend. [Sources: context.md:261-270; validation.md:31,46-52; .claude/rules/nestjs-controllers.md:27-35]
- **Arquivos/Componentes afetados:** `src/videos/videos.controller.ts` ou controller de sub-resource no módulo `videos`; `src/videos/videos.service.ts`; DTO de paginação/listagem; OpenAPI. [Sources: context.md:259-270; .claude/rules/nestjs-controllers.md:36-89]
- **Dependências:** SI-03.1, SI-03.2.
- **Implementation Steps:** expor listagem paginável por `channelId`; retornar somente campos compatíveis com a fase (`publicId`, `status`, thumbnail, metadata essencial, timestamps); aplicar filtro por ownership/estado para esconder drafts de terceiros; manter o padrão `/channels/:channelId/videos`. [Sources: project-plan.md:91-100; context.md:40-46,102-105,261-270]
- **Acceptance Criteria:** sub-resource segue REST/OpenAPI; owner vê próprios drafts/processamento/erros; terceiros e anônimos recebem somente vídeos `ready` até a Fase 04 formalizar visibilidade public/unlisted. [Sources: project-plan.md:5,91-100,117-119; context.md:40-46; .claude/rules/nestjs-controllers.md:11-23,27-35]
- **Testes Obrigatórios:** integração para query/indexes; e2e para auth pública/protegida e serialização. [Sources: context.md:202-207,341-355]
- **Critério de Conclusão:** endpoint suporta consumo futuro por canal/painel sem expor estado interno indevido.

### SI-03.8 — Testes de integração do pipeline
- **Objetivo:** consolidar testes de integração API + DB + Redis + storage para o fluxo upload → queue → status update. [Sources: CLAUDE.md:48-57,70-72; context.md:202-207,337-355]
- **Arquivos/Componentes afetados:** `src/videos/*.integration-spec.ts`; `src/database/migrations.integration-spec.ts` (se expandido); `src/test/*helpers*`; fixtures de storage/queue. [Sources: context.md:202-207,341-355]
- **Dependências:** SI-03.1 a SI-03.7.
- **Implementation Steps:** cobrir criação de draft, persistência de sessão multipart, enqueue BullMQ, transições `draft→processing→ready|error`, idempotência por `jobId`, recuperação parcial e assinatura de URLs. [Sources: technical-decisions-phase-03-videos.md:468-486,514-557; library-refs.md:171-187,438-456]
- **Acceptance Criteria:** testes provam contrato com DB real, query por índices-chave e integração entre módulos/infra dependentes. [Sources: context.md:202-207]
- **Testes Obrigatórios:** `.integration-spec.ts` com DB real e `--runInBand`. [Sources: context.md:202-207]
- **Critério de Conclusão:** suite de integração reproduz os cenários críticos sem mocks internos indevidos.

### SI-03.9 — Testes E2E do ciclo completo
- **Objetivo:** validar o contrato HTTP ponta a ponta: iniciar upload, completar, processar, obter stream/download e listar por canal. [Sources: CLAUDE.md:48-57; context.md:341-355]
- **Arquivos/Componentes afetados:** `nestjs-project/test/videos.e2e-spec.ts`; possíveis ajustes em `test/jest-e2e.json`; helpers de autenticação/seed. [Sources: context.md:202-207,341-355]
- **Dependências:** SI-03.3 a SI-03.8.
- **Implementation Steps:** reproduzir `main.ts` global config; usar supertest; validar DTOs, guards, envelope de erro, contratos públicos e URLs assinadas; garantir cenários owner/non-owner/anônimo. [Sources: .claude/rules/nestjs-controllers.md:81-112]
- **Acceptance Criteria:** fluxo principal fecha sem intervenção manual; erros previsíveis retornam envelope padrão; `@Public()` aparece somente onde a leitura anônima é exigida. [Sources: project-plan.md:5,80-83; .claude/rules/nestjs-controllers.md:11-23,81-89]
- **Testes Obrigatórios:** `test/videos.e2e-spec.ts` cobrindo happy path e falhas centrais. [Sources: context.md:202-207,341-355]
- **Critério de Conclusão:** contrato HTTP da fase fica estável e reproduzível em CI/local containerizado.

### SI-03.10 — Compose, envs e documentação operacional
- **Objetivo:** fechar a fase com `compose.yaml`, `.env.example`, `progress.md` e documentação de operação/validação. [Sources: technical-decisions-phase-03-videos.md:70-74,200-207; context.md:174-194,216-241,337-355]
- **Arquivos/Componentes afetados:** `nestjs-project/compose.yaml`; `nestjs-project/.env.example`; `docs/phases/phase-03-videos/progress.md`; `CLAUDE.md` apenas se nova convenção global surgir; este plano. [Sources: CLAUDE.md:29-38,48-80]
- **Dependências:** SI-03.1 a SI-03.9.
- **Implementation Steps:** adicionar Redis, MinIO e worker ao compose; documentar lifecycle/policies dos buckets; listar env vars phase-specific; registrar avanço dos SIs em `progress.md`; confirmar comandos finais `npm test`, `npm run test:e2e`, `npx tsc --noEmit`, `npm run lint`. [Sources: context.md:183-194,242-248,337-355; validation.md:64-68]
- **Acceptance Criteria:** qualquer pessoa do time consegue subir a stack e saber a ordem de validação/finalização sem consultar outros documentos. [Sources: CLAUDE.md:29-57,70-80]
- **Testes Obrigatórios:** smoke de compose/documentação e validações finais completas da definição de pronto. [Sources: CLAUDE.md:48-57]
- **Critério de Conclusão:** documentação operacional fecha a implementação da fase e elimina lacunas de setup.

## 2. Technical Specifications

### Data Model
- **Colunas obrigatórias da Fase 03:** `id`, `public_id`, `owner_user_id`, `channel_id`, `status`, `original_bucket`, `original_object_key`, `thumbnail_bucket`, `thumbnail_object_key`, `upload_session_id`, `draft_created_at`, `upload_completed_at`, `processing_started_at`, `processing_completed_at`, `metadata_json`, `processing_attempts`, `last_error`, `last_error_at`, `last_error_stack_trace`, `created_at`, `updated_at`. `public_id` é `nanoid(12)` + unique index; `status` usa enum `draft|processing|ready|error`. [Sources: technical-decisions-phase-03-videos.md:328-342,452-486; context.md:317-335; library-refs.md:470-488]
- **Relações:** `Video -> Channel` é obrigatória para listagem/painel; `Video -> User(owner)` é obrigatória para autorização/ownership; manter FKs explícitas e índices em `channel_id`, `owner_user_id`, `status`, `public_id`. [Sources: context.md:100-114,333-335; technical-decisions-phase-03-videos.md:150-161,337-342]
- **Campos do agregado deferidos para Fase 04:** `title`, `description`, `category`, `visibility`, `published_at`, `custom_thumbnail_*` devem aparecer como itens futuros do agregado, mas **não** entram nesta entrega para não misturar escopos. [Sources: project-plan.md:91-102; CLAUDE.md:74-80]
- **Storage keys:** original privado em `videos-originals/{publicId}/original.mp4`; thumbnail pública em `videos-public/{publicId}/{publicId}_default.jpg`; streaming/download sempre no bucket privado. [Sources: technical-decisions-phase-03-videos.md:279-294,374-424; context.md:224-234; library-refs.md:221-228,350-399,434-436]

### API Contracts
| Endpoint | Auth | Request essencial | Response essencial |
|---|---|---|---|
| `POST /videos/upload-session` | Bearer | `channelId`, `filename`, `contentType`, `sizeBytes`, `parts[]?` | `videoId`, `publicId`, `status=draft`, `uploadId`, `objectKey`, `partUrls[]`, `expiresIn=3600` |
| `GET /videos/upload-session/:videoId/parts` | Bearer (owner) | path `videoId` | `uploadId`, `uploadedParts[]`, `missingParts[]` |
| `POST /videos/upload-session/complete` | Bearer (owner) | `videoId`, `uploadId`, `parts[{partNumber,eTag}]` | `videoId`, `status=draft`, `uploadCompletedAt`, `jobId` |
| `DELETE /videos/upload-session/:videoId` | Bearer (owner) | path `videoId` | `204 No Content` |
| `GET /videos/{publicId}` | público para `ready`; owner para demais estados | path `publicId` | `publicId`, `status`, `channelId`, `thumbnailUrl?`, `metadata?`, `errorMessage?` |
| `GET /videos/{publicId}/stream` | público para `ready`; owner para demais estados | path `publicId` | `url`, `expiresIn=1800` |
| `GET /videos/{publicId}/download` | público para `ready`; owner para demais estados | path `publicId` | `url`, `expiresIn=86400`, `filename` |
| `GET /channels/{channelId}/videos` | público para `ready`; owner vê próprios drafts | path/query `channelId,page,limit` | `items[]`, `page`, `limit`, `total` |
[Sources: context.md:259-270; technical-decisions-phase-03-videos.md:110-120,374-424,514-529; .claude/rules/nestjs-controllers.md:29-35,52-89]

- **Envelope de erro:** `{{ statusCode, error, message }}`, com `Authorization: Bearer <access-token>` nos endpoints protegidos e `@ApiBearerAuth('access-token')` na documentação. [Sources: context.md:104-105,160-163; .claude/rules/nestjs-controllers.md:81-89]
- **Exemplos mínimos:** `POST /videos/upload-session` retorna `{{ videoId, publicId, uploadId, objectKey, partUrls:[{{ partNumber, url, expiresIn:3600 }}] }}`; `GET /videos/{publicId}/stream` retorna `{{ url, expiresIn:1800 }}`; `GET /videos/{publicId}/download` retorna `{{ url, expiresIn:86400, filename }}`. [Sources: library-refs.md:336-436; context.md:242-248]

### Authorization Matrix
| Endpoint | Anônimo | Usuário autenticado não-dono | Dono do canal/vídeo |
|---|---|---|---|
| `POST/GET/complete/DELETE /videos/upload-session*` | negado | negado | permitido |
| `GET /videos/{publicId}` com `status=ready` | permitido | permitido | permitido |
| `GET /videos/{publicId}` com `status=draft|processing|error` | negado | negado | permitido |
| `GET /videos/{publicId}/stream` e `/download` com `status=ready` | permitido | permitido | permitido |
| `GET /videos/{publicId}/stream` e `/download` com `status!=ready` | negado | negado | permitido |
| `GET /channels/{channelId}/videos` | somente vídeos `ready` | somente vídeos `ready` | todos os vídeos do próprio canal |
[Sources: project-plan.md:5,71-83,91-100,117-119; context.md:40-46,102-105,259-270; .claude/rules/nestjs-controllers.md:11-23]

### Error Catalog
| Código | HTTP | Mensagem pt-BR | Quando ocorre | Retry/Recovery |
|---|---|---|---|---|
| `VIDEO_NOT_FOUND` | 404 | Vídeo não encontrado. | `publicId`/`videoId` inexistente | não reprocessa |
| `VIDEO_ACCESS_DENIED` | 403 | Você não tem acesso a este vídeo. | usuário não é dono e vídeo não está elegível para leitura pública | solicitar credencial/canal correto |
| `UPLOAD_SESSION_NOT_FOUND` | 404 | Sessão de upload não encontrada. | `uploadId` inválido/expirado | reiniciar sessão |
| `UPLOAD_PARTS_INVALID` | 400 | Lista de partes do upload inválida. | `PartNumber/ETag` incompleto ou fora de ordem | reenviar lista correta |
| `UPLOAD_NOT_COMPLETED` | 409 | O upload do vídeo ainda não foi concluído. | tentativa de processar/streamar antes de `complete` | concluir multipart |
| `VIDEO_NOT_READY` | 409 | O vídeo ainda está em processamento. | stream/download antes de `ready` | aguardar retry/worker |
| `VIDEO_PROCESSING_FAILED` | 422 | O processamento do vídeo falhou. | `status=error` após retries | permitir reprocessamento controlado |
| `STORAGE_REQUEST_FAILED` | 502 | Não foi possível falar com o storage. | falha S3/MinIO/presign | retry exponencial seguro |
[Sources: technical-decisions-phase-03-videos.md:247-250,452-486,514-555; context.md:138-147,306-313; .claude/rules/nestjs-controllers.md:81-112]

### Events/Messages
- **Queue command obrigatório:** `video.process.requested` com `eventId`, `occurredAt`, `videoId`, `publicId`, `ownerUserId`, `sourceBucket`, `sourceObjectKey`, `storageProvider`, `uploadSessionId`, `attempt`; publicar após `complete multipart upload`; `jobId=video-${videoId}`. [Sources: technical-decisions-phase-03-videos.md:514-557; context.md:286-305]
- **Eventos internos/estruturados (não novas filas):** `video.processing.started`, `video.processing.completed`, `video.processing.failed`, sempre com `eventId`, `videoId`, `publicId`, `jobId`, `attempt`, `statusBefore`, `statusAfter`, timestamps e erro quando houver; são logs/observabilidade do worker, não novos contratos de fila, preservando TD-11. [Sources: technical-decisions-phase-03-videos.md:504-555; context.md:312-313]

## 3. Dependency Map

| Ordem | SI | Depende de | Componentes-chave | Bibliotecas-chave |
|---|---|---|---|---|
| 1 | SI-03.1 | — | entity + migration `videos` | TypeORM |
| 2 | SI-03.2 | 03.1 | módulo/controller/service de vídeos | NestJS + TypeORM |
| 3 | SI-03.3 | 03.1, 03.2 | storage + upload session endpoints | AWS SDK v3 + presigner |
| 4 | SI-03.4 | 03.1 | Redis + queue + worker bootstrap | `@nestjs/bullmq`, `bullmq` |
| 5 | SI-03.5 | 03.1, 03.4 | processor + ffprobe/ffmpeg + retry | BullMQ + FFmpeg |
| 6 | SI-03.6 | 03.2, 03.3, 03.5 | signed URLs de stream/download | AWS SDK v3 |
| 7 | SI-03.7 | 03.1, 03.2 | listagem por canal | NestJS controllers/query layer |
| 8 | SI-03.8 | 03.1-03.7 | integração DB/queue/storage | Jest + infra real |
| 9 | SI-03.9 | 03.3-03.8 | E2E HTTP completo | Supertest + Nest testing |
| 10 | SI-03.10 | 03.1-03.9 | compose/env/docs/progress | Docker Compose + docs |
[Sources: technical-decisions-phase-03-videos.md:54-76,108-163,190-209,237-253,277-294,326-344,372-424,448-557; library-refs.md:36-95,99-188,191-436,458-505]

## 4. Infrastructure Requirements
- **Redis:** host `redis`, porta `6379`, URL canônica `redis://redis:6379`; usado pela queue `video-processing`; não usar `localhost` entre containers. [Sources: technical-decisions-phase-03-videos.md:56-63,200-203; context.md:183-185,218-221; CLAUDE.md:29-38]
- **MinIO / S3-compatible:** bucket privado `videos-originals` para `{publicId}/original.mp4`; bucket público `videos-public` para thumbnails; `forcePathStyle=true` em MinIO; lifecycle `AbortIncompleteMultipartUpload` em 1 dia. [Sources: technical-decisions-phase-03-videos.md:279-294; context.md:186-194,224-234; library-refs.md:199-213,296-326]
- **Worker:** container/processo separado da API, compartilhando DB e storage; healthcheck separado; isolamento operacional obrigatório; valores numéricos de CPU/memória **não estão fixados nas fontes** e devem ser definidos no PR de implementação sem alterar `concurrency=2`. [Sources: technical-decisions-phase-03-videos.md:190-209; context.md:151-156,372-377]
- **FFmpeg/ffprobe:** binários no container do worker; sem `fluent-ffmpeg`; a fonte não fixa versão, então o PR deve piná-la na imagem e documentar o valor escolhido. [Sources: library-refs.md:492-505; technical-decisions-phase-03-videos.md:200-205]
- **Docker Compose / volumes / rede:** adicionar serviços `redis`, `minio` e `video-worker`; todos na mesma rede Compose; persistir ao menos storage e banco; usar nomes de serviço (`db`, `redis`, `minio`, `nestjs-api`, `video-worker`) em todas as integrações. [Sources: CLAUDE.md:29-38; technical-decisions-phase-03-videos.md:71-74,200-204]
- **Environment variables (phase-specific):** `REDIS_URL=redis://redis:6379`, `S3_ENDPOINT=http://minio:9000` em dev, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET_ORIGINALS=videos-originals`, `S3_BUCKET_PUBLIC=videos-public`; demais vars de DB/auth são herdadas das fases anteriores. [Sources: context.md:179-194,381-387]

## 5. Upload Flow Details
1. `POST /videos/upload-session` autentica o usuário, valida `channelId`, cria o draft e gera `publicId` antes de abrir a sessão multipart. [Sources: technical-decisions-phase-03-videos.md:135-163; context.md:117-121]
2. A API chama `CreateMultipartUpload` no bucket `videos-originals/{publicId}/original.mp4` e persiste `upload_session_id`. [Sources: library-refs.md:217-229; technical-decisions-phase-03-videos.md:279-281]
3. A API devolve URLs presignadas de `UploadPart` com expiração de 1 hora; o cliente envia partes diretamente ao storage. [Sources: technical-decisions-phase-03-videos.md:117-120; library-refs.md:231-245,356-366,429-432]
4. `GET /videos/upload-session/:videoId/parts` usa `ListParts` para retomada/resume e reconciliação de chunks faltantes. [Sources: library-refs.md:247-260,368-375]
5. `POST /videos/upload-session/complete` recebe `{partNumber,eTag}` ordenados e executa `CompleteMultipartUpload`; em seguida persiste `upload_completed_at` e publica `video.process.requested`. [Sources: technical-decisions-phase-03-videos.md:110-120,470-471,514-529; library-refs.md:262-280,377-399]
6. `DELETE /videos/upload-session/:videoId` executa `AbortMultipartUpload`, preserva rastreabilidade do draft e habilita cleanup lógico. [Sources: library-refs.md:282-317; technical-decisions-phase-03-videos.md:157-161]
7. Limite de 10GB é tratado exclusivamente pelo multipart direto ao storage; a API só orquestra sessão, estado e assinatura. [Sources: project-plan.md:71-83,165-169; technical-decisions-phase-03-videos.md:84-120]
8. Falhas de rede/reenvio atuam no nível da parte; se a sessão expirar, o cliente renegocia URLs/listagem em vez de reiniciar o arquivo inteiro. [Sources: technical-decisions-phase-03-videos.md:84-120; library-refs.md:247-260,429-432]

## 6. Processing Flow Details
1. `complete multipart upload` publica `video.process.requested` na queue `video-processing` com `jobId=video-${videoId}`. [Sources: technical-decisions-phase-03-videos.md:514-545; context.md:126-129,297-304]
2. O worker faz preflight `SELECT id, status FROM videos WHERE id = ? LIMIT 1`; `ready` e `processing` não geram execução paralela independente; `error` aceita retry; `draft` aguarda upload concluído. [Sources: technical-decisions-phase-03-videos.md:532-537; library-refs.md:171-187]
3. Ao iniciar, o worker muda `draft→processing`, grava `processing_started_at` e incrementa `processing_attempts`. [Sources: technical-decisions-phase-03-videos.md:469-473]
4. Executa `ffprobe` para duração/resolução/codec/fps/bitrate e persiste `metadata_json` imediatamente quando bem-sucedido. [Sources: technical-decisions-phase-03-videos.md:239-250; library-refs.md:501-505]
5. Executa `ffmpeg` para thumbnail default em ~25% da duração, com clamp mínimo/máximo, e grava no bucket público. [Sources: technical-decisions-phase-03-videos.md:239-250; library-refs.md:503-505]
6. Sucesso completo fecha `processing_completed_at` e `status=ready`. [Sources: technical-decisions-phase-03-videos.md:471-475]
7. Falha no `ffprobe` leva a `status=error`, `last_error*` preenchidos e backoff exponencial até 5 tentativas. [Sources: technical-decisions-phase-03-videos.md:247-250,473-474; library-refs.md:165-169,440-445]
8. Falha apenas da thumbnail preserva metadata; retries seguintes pulam `ffprobe`; após 5 falhas, o vídeo pode terminar `ready` sem thumbnail. [Sources: technical-decisions-phase-03-videos.md:248-250,474-475; library-refs.md:446-456]
9. Não há deleção automática de artefatos parciais em falha permanente; manter para diagnóstico/manual cleanup futuro. [Sources: technical-decisions-phase-03-videos.md:250; library-refs.md:454-456]
10. O histórico detalhado de tentativas fica em logs estruturados/BullMQ; a tabela guarda apenas o último erro + contagem resumida. [Sources: technical-decisions-phase-03-videos.md:479-486,552-555; context.md:312-313]

## 7. Streaming/Download Flow
- `GET /videos/{publicId}/stream` retorna URL assinada de 30 minutos apontando para `videos-originals/{publicId}/original.mp4`; `Range`/`206` é servido pelo storage, não pela API. [Sources: technical-decisions-phase-03-videos.md:372-386; library-refs.md:401-413]
- `GET /videos/{publicId}/download` retorna URL assinada de 24 horas com `Content-Disposition: attachment`; o objeto continua privado. [Sources: technical-decisions-phase-03-videos.md:410-424; library-refs.md:416-436]
- Zero proxy pela API é obrigatório para upload, stream e download. [Sources: context.md:153-156; technical-decisions-phase-03-videos.md:379-384,412-417]
- Autorização: nesta fase, leitura pública vale para vídeos `ready`; drafts/processando/erro continuam restritos ao owner até a Fase 04 formalizar `public/unlisted`. [Sources: project-plan.md:5,91-100,117-119; context.md:40-46]

## 8. Persistence Layer
- **DDL da migration:** criar `videos`; adicionar enum/status, FKs para `users` e `channels`, unique index em `public_id`, índices em `channel_id`, `owner_user_id`, `status`; incluir `processing_attempts`, `last_error`, `last_error_at`, `last_error_stack_trace`; não criar tabela separada de tentativas. [Sources: technical-decisions-phase-03-videos.md:337-342,456-486; context.md:317-335; validation.md:38-40]
- **Schema TypeORM:** entidade explícita, tabela nomeada, colunas tipadas, relações bidirecionais necessárias com `Channel` e `User(owner)`; timestamps automáticos e JSON tipado para `metadata_json`. [Sources: context.md:198-205,315-335; CLAUDE.md:42-46]
- **Strategy de `publicId`:** `nanoid(12)` imutável, lookup público principal e prefixo de storage. [Sources: technical-decisions-phase-03-videos.md:326-344; library-refs.md:470-488]
- **Formato de `metadata_json`:** `{ durationSeconds, width, height, codec, fps, bitrate, container, probedAt }`; guardar apenas metadados derivados do `ffprobe` necessários ao player/painel. [Sources: technical-decisions-phase-03-videos.md:239-250; context.md:109-113]

## 9. Testing Strategy
- **Unit:** services com branching (`videos.service`, orchestration de upload, processor decisions, utils de FFmpeg/S3) e providers de autorização/idempotência; controllers não recebem unit tests isolados. [Sources: CLAUDE.md:44-57]
- **Integration:** entity/migration `videos`, queries por canal, persistência de sessão multipart, queue wiring, worker + Redis + storage quando o contrato com infra real for a parte testada; usar `.integration-spec.ts` e `--runInBand`. [Sources: context.md:202-207,341-355]
- **E2E:** `test/videos.e2e-spec.ts` deve cobrir upload-session happy path, resume, abort, processamento, stream, download e listagem por canal; aplicar explicitamente pipes/filtros globais no bootstrap de teste. [Sources: context.md:341-355]
- **Infra real quando aplicável:** Redis, MinIO/S3-compatible e worker devem ser usados em integração/E2E dos fluxos críticos desta fase; mocks apenas nas fronteiras estritamente unitárias. [Sources: project-plan.md:71-83,165-169; technical-decisions-phase-03-videos.md:190-209]
- **Cobertura mínima esperada:** provar happy path + falhas canônicas (`ffprobe`, thumbnail, access denied, upload incompleto, idempotência), depois rodar `npm test`, `npm run test:e2e`, `npx tsc --noEmit`, `npm run lint` antes de encerrar. [Sources: CLAUDE.md:48-57,70-72; context.md:337-355]

## 10. Deployment & Closure
- Atualizar `docs/phases/phase-03-videos/progress.md` a cada SI concluído; usar o arquivo como rastreador oficial desta phase. [Source: user brief]
- Só atualizar `CLAUDE.md` se surgir convenção global nova; caso contrário, documentar tudo da phase no próprio diretório `docs/phases/phase-03-videos/`. [Sources: CLAUDE.md:46,74-80]
- Ordem de fechamento: testes afetados → suíte completa `npm test` → `npm run test:e2e` → `npx tsc --noEmit` → `npm run lint`. [Sources: CLAUDE.md:48-57,70-72]
- Commit final deve seguir Git Flow/documentação do repositório (`feature/*` ou `docs/*`, mensagem curta focada no porquê); não misturar escopo desta phase com frontend ou Fase 04. [Sources: CLAUDE.md:60-80]

## Bloqueios antes da implementação
- Não há bloqueio funcional aberto no pacote documental: `validation.md` está clean e a rastreabilidade do endpoint `/channels/{channelId}/videos` já foi resolvida. [Sources: validation.md:16-25,46-68]
- Ponto a fixar no PR de implementação, sem mudar decisão: pin da versão do binário FFmpeg/ffprobe e definição concreta de CPU/memória do worker no compose/infra. [Sources: technical-decisions-phase-03-videos.md:198-205; library-refs.md:492-505]
