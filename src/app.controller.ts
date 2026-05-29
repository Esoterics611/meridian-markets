import { Controller, Get, Redirect } from '@nestjs/common';

// Root convenience: the engine has no UI at `/` — the live console is at /demo.
// Redirect so a bare http://localhost:3100 lands on the desk instead of a 404.
@Controller()
export class AppController {
  @Get()
  @Redirect('/demo', 302)
  root(): void {}
}
