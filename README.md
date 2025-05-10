Okay, aqui está um README simples e acessível para o seu `scraper.js`, incluindo a licença MIT.

# LegisFacil Scraper

Um scraper Node.js simples para extrair dados de legislação do portal da Câmara dos Deputados (`camara.leg.br`) e salvá-los em um banco de dados MongoDB.

## Funcionalidades

*   Extrai listas de proposições legislativas das páginas de busca.
*   Para cada proposição, acessa a página de detalhes para obter informações completas.
*   Extrai dados como título, ementa, texto original (se disponível), situação, origem, etc.
*   Salva os dados coletados em uma coleção MongoDB, atualizando registros existentes (upsert) com base na URL.
*   Configurável através de variáveis de ambiente (limite de páginas, concorrência, delays).
*   Implementa lógica de retentativas para requisições HTTP.
*   Evita processamento duplicado de URLs já visitadas na sessão atual.
*   Adiciona delays entre requisições para não sobrecarregar o servidor de origem.

## Pré-requisitos

*   [Node.js](https://nodejs.org/) (versão 16 ou superior recomendada)
*   [npm](https://www.npmjs.com/) (geralmente vem com o Node.js) ou [yarn](https://yarnpkg.com/)
*   Acesso a uma instância MongoDB (local ou remota)

## Instalação

1.  Clone este repositório ou baixe o arquivo `scraper.js`.
    ```bash
    # Se você tiver um repositório git
    # git clone <url_do_seu_repositorio>
    # cd <nome_do_repositorio>

    # Ou apenas crie um diretório e coloque o scraper.js dentro
    mkdir legisfacil-scraper
    cd legisfacil-scraper
    # Adicione o arquivo scraper.js aqui
    ```

2.  Instale as dependências:
    ```bash
    npm install axios cheerio mongodb dotenv p-limit
    ```
    ou
    ```bash
    yarn add axios cheerio mongodb dotenv p-limit
    ```

## Configuração

Crie um arquivo chamado `.env` na raiz do projeto com as seguintes variáveis:

```env
# Obrigatório: String de conexão do seu MongoDB
MONGODB_URI="mongodb://localhost:27017"

# Opcional: Nome do banco de dados (padrão: legisfacil)
# DB_NAME="legisfacil"

# Opcional: Nome da coleção (padrão: legislation)
# COLLECTION_NAME="legislation"

# Opcional: Número máximo de páginas de busca a serem raspadas (padrão: 10)
# MAX_PAGES_TO_SCRAPE=10

# Opcional: Quantas páginas de detalhe buscar em paralelo (padrão: 5)
# DETAIL_FETCH_CONCURRENCY=5

# Opcional: Quantos documentos enviar ao MongoDB por vez (padrão: 50)
# DB_BATCH_SIZE=50

# Opcional: Delay em milissegundos entre buscas de páginas de resultados (padrão: 2000)
# DELAY_BETWEEN_SEARCH_PAGES_MS=2000

# Opcional: Delay em milissegundos entre buscas de páginas de detalhes (padrão: 500)
# DELAY_BETWEEN_DETAIL_FETCHES_MS=500
```

**Importante:** Certifique-se de que seu servidor MongoDB está rodando e acessível pela `MONGODB_URI` fornecida.

## Uso

Para iniciar o scraper, execute o seguinte comando no terminal, a partir do diretório do projeto:

```bash
node scraper.js
```

O script começará a buscar os dados e exibi-los no console, salvando-os no MongoDB configurado.

## Como Funciona

1.  **Conexão com MongoDB:** Estabelece conexão com o banco de dados e garante a criação de índices na coleção de legislação para otimizar buscas e garantir unicidade de URLs.
2.  **Busca Inicial:** Começa na URL base de busca da legislação da Câmara.
3.  **Paginação:** Navega pelas páginas de resultados da busca.
4.  **Extração de Itens:** Em cada página de resultados, identifica os links para as páginas de detalhes de cada item legislativo.
5.  **Busca de Detalhes:** Para cada item, acessa sua URL de detalhe.
    *   Realiza a busca dos detalhes de forma concorrente (limitada por `DETAIL_FETCH_CONCURRENCY`).
    *   Adiciona um delay (`DELAY_BETWEEN_DETAIL_FETCHES_MS`) entre cada requisição de detalhe.
6.  **Extração de Dados Detalhados:** Na página de detalhes, extrai informações como:
    *   Título
    *   Ementa
    *   URL e conteúdo do texto original (se disponível)
    *   Proposição originária
    *   Origem
    *   Situação atual
    *   Indexação (palavras-chave)
7.  **Armazenamento:** Os dados coletados (tanto da busca quanto dos detalhes) são combinados e salvos no MongoDB.
    *   Utiliza `bulkWrite` com operações `updateOne` e `upsert: true`, o que significa que se um documento com a mesma URL já existir, ele será atualizado; caso contrário, um novo documento será inserido.
    *   Registra `createdAt` na inserção e `lastFetchedAt` em cada operação.
8.  **Controle e Delays:**
    *   Limita o número de páginas de busca (`MAX_PAGES_TO_SCRAPE`).
    *   Adiciona um delay (`DELAY_BETWEEN_SEARCH_PAGES_MS`) entre o processamento de cada página de busca.
    *   Implementa retentativas com delay exponencial para requisições HTTP que falharem.
    *   Detecta e interrompe loops de paginação.

## Dados Coletados (Exemplo de Campos no MongoDB)

*   `url`: URL única da página de detalhes da legislação.
*   `searchResultTitle`: Título como aparece nos resultados da busca (pode ser substituído pelo `title` da página de detalhes).
*   `searchResultDescription`: Descrição breve dos resultados da busca.
*   `searchResultStatus`: Situação como aparece nos resultados da busca (pode ser substituído pela `situacao` da página de detalhes).
*   `title`: Título oficial da norma (da página de detalhes).
*   `ementa`: Ementa da norma.
*   `originalTextUrl`: Link para o texto original da norma.
*   `originalText`: Conteúdo do texto original (se obtido).
*   `proposicaoOriginaria`: Link ou nome da proposição que deu origem à norma.
*   `origem`: Órgão de origem da norma (e.g., Executivo, Legislativo).
*   `situacao`: Situação atual da norma (e.g., Em Vigor, Revogada).
*   `indexacao`: Termos de indexação ou palavras-chave.
*   `lastFetchedAt`: Data e hora da última vez que o item foi buscado/atualizado.
*   `createdAt`: Data e hora da criação do registro no banco.
*   `fetchError` (booleano): `true` se houve erro ao buscar detalhes e apenas informações mínimas foram salvas.
*   `lastAttemptedAt`: Data da última tentativa de busca, em caso de erro.

## Atenção

Este scraper foi desenvolvido para fins educacionais e de coleta de dados públicos. Utilize-o de forma responsável, respeitando os termos de serviço do site da Câmara dos Deputados e evitando sobrecarregar seus servidores. Os delays configurados ajudam a mitigar esse risco.

## Licença

Este projeto está licenciado sob a Licença MIT. Veja o arquivo [LICENSE](LICENSE) para mais detalhes.

