# @douglas-agent/sandbank-daytona

> Daytona cloud sandbox adapter for [Sandbank](../../README.md).

## Install

```bash
pnpm add @douglas-agent/sandbank-core @douglas-agent/sandbank-daytona
```

## Usage

```typescript
import { createProvider } from '@douglas-agent/sandbank-core'
import { DaytonaAdapter } from '@douglas-agent/sandbank-daytona'

const provider = createProvider(
  new DaytonaAdapter({
    apiKey: process.env.DAYTONA_API_KEY!,
    apiUrl: 'https://app.daytona.io/api', // optional
  })
)

const sandbox = await provider.create({
  image: 'node:22',
  resources: { cpu: 2, memory: 4096 },
  autoDestroyMinutes: 60,
})

const { stdout } = await sandbox.exec('node --version')
await sandbox.writeFile('/app/index.js', 'console.log("hello")')
await provider.destroy(sandbox.id)
```

## Capabilities

| Capability | Supported |
|------------|:---------:|
| `terminal` | ✅ |
| `volumes` | ✅ |
| `port.expose` | ✅ |

## Characteristics

- **Runtime:** Full VM
- **Cold start:** ~10s
- **File I/O:** Native SDK
- **Region:** Multi
- **Dependency:** `@daytonaio/sdk`

## License

MIT
