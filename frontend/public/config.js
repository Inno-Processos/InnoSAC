// Configuração do frontend. O servidor do frontend (server.js) gera este arquivo a partir do .env;
// esta cópia estática serve para hospedar a pasta public/ em outro servidor (Nginx, CDN...).
// apiUrl vazio = mesma origem (o servidor do frontend repassa /api e /drive ao backend).
window.SAC_CONFIG = { apiUrl: '' };
