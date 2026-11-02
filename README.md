# synology-mcp

Servidor MCP para gerir um NAS Synology (DSM 7) a partir do Claude ou de outro cliente MCP: saúde do sistema, discos, ficheiros, Container Manager, contas, segurança, Photos, Drive e qualquer outra API DSM que o NAS tenha.

- **Só aparecem as ferramentas que fazem sentido.** No arranque, o servidor lê a lista de APIs do próprio NAS (`SYNO.API.Info`, sem login) e esconde o que não está instalado. Um pacote que não tens não gasta contexto.
- **2FA sem códigos repetidos.** Um único código na `setup` troca-se por um token de dispositivo de confiança, guardado no Keychain.
- **O certificado do NAS fica fixado.** O certificado por omissão do DSM é autoassinado. Em vez de desligar a verificação, a impressão digital é fixada e confirmada em cada ligação, antes de a palavra-passe sair.
- **Não bloqueia o teu IP.** Credenciais recusadas nunca são reenviadas, para não disparar o Auto Block do DSM.
- **Mudanças perigosas pedem confirmação.** Apagar, partilhar publicamente ou parar serviços devolve primeiro uma pré-visualização.
- **Cobertura completa.** `dsm_api_search` e `dsm_read` chegam a qualquer API do NAS, mesmo sem ferramenta dedicada.

## Instalar e ligar

Precisa de Node 22 ou mais recente.

```bash
npm install -g github:joaomelorodrigues/synology-mcp
synology-mcp setup --url https://nas.example.com:5001
```

O `npm` descarrega o código já compilado, instala as dependências e cria o comando `synology-mcp`. Se o repositório for privado, o Git deste computador tem de ter acesso a ele (uma chave SSH, ou `gh auth setup-git`). Para atualizar, repete o primeiro comando: a configuração e os segredos ficam fora do pacote e mantêm-se.

A `setup` mostra o certificado do NAS e pede para o fixar, depois pede o utilizador, a palavra-passe (invisível), o nível de permissões e o código 2FA. No fim, imprime o comando para ligar o cliente, por exemplo:

```bash
claude mcp add --scope user synology -- /caminho/para/node /caminho/para/dist/index.js serve
```

Para verificar a ligação e experimentar todas as ferramentas de leitura no NAS:

```bash
synology-mcp doctor
```

O relatório não contém segredos.

> A porta faz parte do endereço. O DSM usa 5001 (HTTPS) e 5000 (HTTP) por omissão, e as portas 443 e 80 podem estar a servir o Web Station. Se o endereço dado não for o DSM, a `setup` experimenta as portas habituais. Vê a tua em Painel de Controlo > Portal de Início de Sessão.
>
> Se o NAS só for acessível por VPN, as ferramentas devolvem um erro a dizê-lo enquanto ela estiver desligada, e voltam a funcionar quando ligar.
>
> O comando `claude mcp add` que a `setup` imprime aponta para a versão atual do Node. Se usares nvm e mudares de versão, instala outra vez e volta a correr esse comando.

## Níveis de permissões

O nível é definido em `tier`. As ferramentas acima do nível nem sequer são registadas, por isso não há como o modelo as usar por engano.

| Nível | O que permite |
|---|---|
| `read` (por omissão) | Só consultas |
| `write` | Ficheiros, contentores, pacotes, tarefas e backups. Apagar pede confirmação |
| `admin` | Também contas, shared folders, serviços, reverse proxy e `dsm_write` |
| `allowPower: true` | À parte dos níveis: reiniciar, desligar e instalar atualizações do DSM |

Por mais alto que seja o nível, ficam sempre de fora os segredos (OTP, chaves de encriptação, recuperação de conta) e qualquer alteração à estrutura dos discos (criar, apagar ou reparar pools e volumes). Esses casos ficam para o DSM.

## Configuração

Ficheiro em `~/.config/synology-mcp/config.json`, sem segredos. As variáveis de ambiente têm prioridade; ver [.env.example](.env.example).

```json
{
  "url": "https://nas.example.com:5001",
  "username": "mcp-admin",
  "tier": "write",
  "allowPower": false,
  "modules": "all",
  "certFingerprint": "AB:CD:EF:...",
  "localRoots": ["~/Downloads"],
  "protectedPaths": ["/backups"],
  "instructions": "Os backups estão em /backups. Confirma sempre antes de mexer em /docker."
}
```

| Campo | Efeito |
|---|---|
| `modules` | `"all"`, ou uma lista: `system`, `storage`, `files`, `docker`, `packages`, `accounts`, `services`, `security`, `network`, `backup`, `scheduler`, `photos`, `drive`, `downloads`, `vm`, `surveillance`, `generic` |
| `localRoots` | Pastas deste computador que o upload e o download podem usar. Symlinks e `..` são resolvidos antes de verificar |
| `protectedPaths` | Caminhos do NAS que nenhuma ferramenta altera ou apaga |
| `instructions` | Texto extra para o modelo sobre este NAS |
| `maxOutputChars` | Tamanho máximo de uma resposta, 40 000 por omissão |

O servidor lê a configuração ao arrancar. Depois de a alterares, reinicia o cliente MCP.

## Ferramentas

`synology-mcp tools --hidden` mostra as ferramentas desta ligação e o custo em contexto. Num NAS com Container Manager, Photos e Drive, mas sem Hyper Backup, Download Station, VMM nem Surveillance Station, são 57 no nível `read` (cerca de 8 mil tokens), 77 em `write` (12 mil) e 89 em `admin` (14 mil).

| Área | Leitura | Escrita |
|---|---|---|
| Visão geral | `nas_overview`, `nas_capabilities`, `system_info`, `system_load`, `system_processes`, `system_connections`, `system_logs`, `system_network`, `system_hardware`, `dsm_update_status` | `nas_power`, `dsm_update_install` |
| Armazenamento | `storage_overview`, `storage_disk`, `storage_volume_usage`, `storage_schedules`, `storage_snapshots`, `iscsi_list` | |
| Ficheiros | `files_shares`, `files_list`, `files_info`, `files_search`, `files_dir_size`, `files_md5`, `files_read`, `files_download`, `files_task_status`, `files_links` | `files_write`, `files_upload`, `files_mkdir`, `files_rename`, `files_copy_move`, `files_delete`, `files_compress`, `files_extract`, `files_task_stop`, `files_link_create`, `files_link_delete` |
| Container Manager | `docker_containers`, `docker_container`, `docker_logs`, `docker_stats`, `docker_images`, `docker_projects`, `docker_networks`, `docker_registry_search` | `docker_container_control`, `docker_project_control`, `docker_project_save`, `docker_image_pull`, `docker_delete` |
| Pacotes | `packages_list` | `package_control` |
| Contas e shares | `users_list`, `groups_list`, `shares_list`, `share_nfs_rules` | `user_create`, `user_update`, `user_delete`, `user_groups_set`, `user_share_permission_set`, `share_create`, `share_delete`, `share_nfs_rule_set` |
| Serviços e segurança | `services_status`, `security_overview`, `security_certificates`, `security_login_activity` | `service_set` |
| Rede | `network_services`, `reverse_proxy_list` | `reverse_proxy_create`, `reverse_proxy_delete` |
| Tarefas e backups | `scheduler_tasks`, `backup_tasks` | `scheduler_run`, `backup_run` |
| Photos e Drive | `photos_collections`, `photos_items`, `photos_search`, `photos_download`, `drive_status`, `drive_list`, `drive_search`, `drive_labels` | `photos_album_create`, `photos_album_add` |
| Download Station, VMM, Surveillance | `downloads_list`, `vm_list`, `surveillance_cameras` | `download_add`, `download_control`, `vm_control` |
| Qualquer API | `dsm_api_search`, `dsm_read` | `dsm_write` |

As ferramentas de um pacote que não esteja instalado ficam escondidas. Aparecem sozinhas quando o instalares e reiniciares o cliente.

## Como funciona o 2FA

1. A `setup` faz login com palavra-passe e código, e pede ao DSM um token de dispositivo de confiança.
2. A palavra-passe e o token ficam no Keychain do macOS (noutros sistemas, num ficheiro com permissão `600`).
3. Os logins seguintes usam o token, sem código.

Este computador aparece em **DSM > Pessoal > Segurança > Dispositivos com sessão iniciada** como `synology-mcp`. Se removeres esse dispositivo, o erro seguinte diz o que fazer: ou dás um código ao modelo, que chama `nas_auth_otp`, ou voltas a correr a `setup`.

## Segurança

- A palavra-passe e o token vão sempre no corpo de um POST, nunca num URL, e nunca são escritos em respostas ou registos.
- As variáveis de ambiente dos contentores e os ficheiros Compose podem ter segredos, por isso só são devolvidos quando pedidos explicitamente. `dsm_read` esconde campos com nomes como `password` ou `token`.
- Conteúdo vindo do NAS (ficheiros, nomes, registos) pode ter texto escrito por qualquer pessoa. As instruções do servidor dizem ao modelo para o tratar como dados.
- `files_delete` e `files_copy_move` recusam um shared folder inteiro, porque no DSM isso apaga o próprio shared folder, sem passar pela reciclagem. Para isso existe `share_delete`, que exige escrever o nome.
- `tier: read` é o nível por omissão. Se usares uma conta DSM dedicada com menos privilégios, os limites do próprio DSM aplicam-se por cima destes.

Se substituíres o certificado do NAS, a ligação passa a ser recusada até correres `synology-mcp trust-cert`. É intencional: de outro lado do erro pode estar alguém a intercetar a ligação.

## Correr noutra máquina, por HTTP

Por omissão, o cliente arranca o servidor localmente por stdio. Para o manter sempre ligado, por exemplo no próprio NAS:

```bash
docker compose run --rm -it synology-mcp setup --url https://nas.example.com:5001
SYNOLOGY_MCP_TOKEN=$(openssl rand -hex 32) docker compose up -d
```

O endpoint é `http://127.0.0.1:8765/mcp`. Fora do loopback, o servidor recusa arrancar sem `SYNOLOGY_MCP_TOKEN` e `SYNOLOGY_MCP_ALLOWED_HOSTS`. Para o expor, coloca à frente um reverse proxy HTTPS. Quem chegar a este endpoint com o token faz tudo o que o nível configurado permitir.

## Resolução de problemas

| Sintoma | O que fazer |
|---|---|
| `answered, but not as DSM's Web API` | Falta a porta do DSM no URL (Painel de Controlo > Portal de Início de Sessão) |
| `Could not reach the NAS` | Confirma a VPN |
| `different TLS certificate` | Se substituíste o certificado, `trust-cert`. Se não, não avances |
| `DSM refused the login` | Corrige na `setup`. O servidor não volta a tentar até as credenciais mudarem ou reiniciar |
| `blocked by DSM Auto Block` | Remove o IP em Painel de Controlo > Segurança > Proteção e reinicia o servidor |
| `permission_denied` (105) | A maioria das APIs de sistema e armazenamento exige uma conta de administrador |
| Uma ferramenta não aparece | Pede ao modelo `nas_capabilities`, que diz porque está escondida |

## Desenvolvimento

```bash
git clone https://github.com/joaomelorodrigues/synology-mcp.git
cd synology-mcp
npm install
npm test                         # compila e corre os testes contra um DSM falso, por HTTP real
TEST_KEYCHAIN=1 npm test         # inclui o Keychain real, com um item temporário
npm run typecheck
```

O `dist/` está no repositório porque é ele que o `npm install -g` instala. Com `-g`, um pacote vindo de git com um script chamado `build`, `prepare`, `prepack`, `preinstall`, `install` ou `postinstall` fica instalado como link para uma pasta temporária já apagada, por isso o script de compilação chama-se `compile`. Depois de alterar `src/`, corre `npm run compile` e inclui o `dist/` no commit. A verificação do GitHub Actions falha se te esqueceres.

O código está dividido em `src/dsm` (cliente DSM: sessão, TLS, erros), `src/mcp` (registo de ferramentas, formatos, guardas de caminhos, transporte HTTP), `src/tools` (ferramentas por área) e `src/cli` (`setup`, `doctor`, `tools`). Para acrescentar uma ferramenta, junta um `tool({...})` em `src/tools` com o nível e as APIs de que depende.

### Estado da verificação

Os testes cobrem o comportamento do servidor contra um DSM simulado. Num NAS real, só se confirmou a descoberta das APIs e a fixação do certificado, sem login. O formato das chamadas vem dos projetos de referência abaixo, que as testaram em DSM 7.x, mas falta confirmá-lo com login:

- As ferramentas de leitura confirmam-se com `doctor`. Algumas não têm equivalente nas referências, por isso são as primeiras a vigiar: `security_login_activity`, `drive_labels`, `photos_items` sem origem.
- As ferramentas de escrita só se confirmam a usá-las. Experimenta-as primeiro com dados sem importância, sobretudo `files_compress`, que também não tem equivalente nas referências.

### Referências

As convenções da API DSM foram estudadas nestes projetos: [cmeans/mcp-synology](https://github.com/cmeans/mcp-synology), [rafalr100/synology-mcp](https://github.com/rafalr100/synology-mcp), [atom2ueki/mcp-server-synology](https://github.com/atom2ueki/mcp-server-synology) e [vocweb/synology-mcp-server](https://github.com/vocweb/synology-mcp-server). O código aqui é próprio.

## Licença

[MIT](LICENSE). Não afiliado à Synology Inc.
