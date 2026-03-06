# Tasklist - Publicacao Edge Add-ons

## Concluido

- [x] Extensao MV3 funcional (popup, options, content script, background).
- [x] TTS do player Udemy funcionando com vozes nativas do navegador.
- [x] Ajuste automatico de velocidade com limites configuraveis (`autoRateMin` / `autoRateMax`).
- [x] Modo resumo/salvamento desativado no runtime (`FILE_SAVE_DISABLED = true`).
- [x] Bloco de resumo oculto no popup.
- [x] Repositorio Git criado e publicado em `mathiasvinicius/udemy-tts`.
- [x] Validacao de sintaxe JS (`node --check` em `content.js`, `popup.js`, `config.js`, `background.js`).
- [x] Remover `host_permissions` de localhost (`127.0.0.1` / `localhost`) do `manifest.json`.
- [x] Remover fluxo de integracao local da build da loja:
- [x] Remover/neutralizar `INTEGRATION_REQUEST` em `background.js`.
- [x] Ocultar/remover campos e botoes de integracao em `config.html` / `config.js`.
- [x] Remover `integration.html` da build da loja.
- [x] Adicionar `icons` no `manifest.json` (ex.: 16, 48, 128).

## Pendente (antes de enviar para a loja)

- [x] Revisar `README.md` para refletir claramente a versao publicada na loja.
- [x] Gerar pacote `.zip` somente com arquivos necessarios da extensao.
- [x] Preparar texto base da listing no Edge Add-ons:
- [x] Nome, descricao curta e longa, categoria (`edge-listing.md`).
- [ ] Capturas de tela finais da extensao em uso (popup + config + player Udemy).
- [x] Definir URL/pagina de suporte e politica de privacidade (docs versionadas no repo).
- [ ] Executar teste final de instalacao limpa no Edge (perfil novo).

## Opcional (pos-publicacao)

- [ ] Criar pipeline de release (`store` vs `dev`) para separar build sem integracao local.
- [ ] Automatizar checklist de pre-publicacao.
