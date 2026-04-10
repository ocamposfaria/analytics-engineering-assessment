# Analytics Engineer Assessment

Projeto end-to-end de analytics: o **dbt** em DuckDB materializa marts de conversao; o **FastAPI** expoe os dados (incluindo Swagger e endpoints da assistente); e o **dashboard** estatico consome esses endpoints.

## Preview

![Dashboard preview](image.png)

## Estrutura do repositorio

| Caminho | Finalidade |
|---|---|
| `backend/` | Backend Python (`api.py` + `assistant_chat.py`) |
| `web/` | Dashboard (`index.html`, `app.css`, `dashboard.js`) |
| `vineskills_analytics/` | Projeto dbt (models, seeds, analyses, `profiles.yml`) |
| `data/` | Criado em runtime para `assistant_chat.sqlite` |
| `requirements.txt` | Dependencias Python |
| `index.html` (raiz) | Redirect para `web/index.html` |

## Pre-requisitos

- Python 3.10+
- `pip`
- (Opcional) `OPENAI_API_KEY` para usar os endpoints da assistente
- Dependencias do dbt (ja incluidas em `requirements.txt`)

## 1) Instalar dependencias (Windows, macOS e Linux)

No diretorio raiz do projeto:

```bash
pip install -r requirements.txt
```

Se for usar variaveis locais, copie `.env.example` para `.env`. O backend faz load automatico desse arquivo.

## 2) Build do warehouse com dbt

No diretorio raiz do projeto, rode:

### Windows (PowerShell)

```powershell
cd .\vineskills_analytics
dbt build
dbt docs generate
cd ..
```

### macOS / Linux (bash/zsh)

```bash
cd vineskills_analytics
dbt build
dbt docs generate
cd ..
```

Isso gera o banco DuckDB em `vineskills_analytics/target/vineskills.duckdb` (ou no caminho definido em `DUCKDB_PATH`).

## 3) Subir os 3 servicos

Abra **3 terminais** diferentes na raiz do repositorio.

### Terminal A - FastAPI (API + Swagger)

Comando igual para Windows/macOS/Linux:

```bash
uvicorn backend.api:app --reload --host 127.0.0.1 --port 8000
```

Acessos:
- Swagger UI: `http://127.0.0.1:8000/docs`
- ReDoc: `http://127.0.0.1:8000/redoc`
- Health: `http://127.0.0.1:8000/health`

### Terminal B - dbt Docs

No diretorio `vineskills_analytics`:

#### Windows (PowerShell)

```powershell
cd .\vineskills_analytics
dbt docs serve --port 8081
```

#### macOS / Linux (bash/zsh)

```bash
cd vineskills_analytics
dbt docs serve --port 8081
```

Acesso: `http://127.0.0.1:8081`

### Terminal C - Dashboard estatico

Comando igual para Windows/macOS/Linux:

```bash
python -m http.server 8080
```

Acesso:
- Dashboard direto: `http://127.0.0.1:8080/web/`
- Redirect da raiz: `http://127.0.0.1:8080/`

## Variaveis de ambiente (referencia)

| Variavel | Uso |
|---|---|
| `DUCKDB_PATH` | Caminho do DuckDB usado pela API e assistente |
| `OPENAI_API_KEY` | Necessaria para endpoints da assistente |
| `OPENAI_MODEL` | Override opcional de modelo na assistente |
| `ASSISTANT_SQLITE_PATH` | Caminho opcional do SQLite de conversas |

## Observacoes

- O dashboard espera API em `http://127.0.0.1:8000` por padrao (configuravel em `window.DASH_API_BASE` em `web/dashboard.js`).
- Para encerrar tudo, interrompa os 3 terminais (`Ctrl + C`).
