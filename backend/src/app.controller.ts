import { Controller, Get } from '@nestjs/common'
import { Public } from './auth/public.decorator.js'

@Controller()
export class AppController {
  @Public()
  @Get('health')
  health() {
    return { status: 'ok', service: 'internal-assistant' }
  }
}
