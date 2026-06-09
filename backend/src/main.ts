import 'reflect-metadata'
import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import cookieParser from 'cookie-parser'
import { AppModule } from './app.module.js'
import { AppConfig } from './config/app-config.service.js'

const PORT = Number(process.env.PORT ?? 8000)

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  })
  const config = app.get(AppConfig)

  app.setGlobalPrefix('api')
  // Signed-cookie secret must match the one MSAL's auth_tx cookie was set with.
  app.use(cookieParser(config.sessionSecret))
  app.enableCors({
    origin: config.frontendUrl,
    credentials: true,
  })

  await app.listen(PORT)
  console.log(`Internal Assistant backend running on http://localhost:${PORT}`)
}
bootstrap().catch((e) => { console.error(e); process.exit(1) })
