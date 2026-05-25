# Telegram Community Bot (Français)

Un bot Telegram communautaire complet avec parrainage, récompenses, tâches, classement, retraits et contrôles administrateur. Prêt pour les futures intégrations crypto/token.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — démarrer le serveur API + bot Telegram (port configuré par env)
- `pnpm run typecheck` — vérification complète des types
- `pnpm --filter @workspace/api-spec run codegen` — regénérer les hooks et schémas Zod depuis la spec OpenAPI
- `pnpm --filter @workspace/db run push` — appliquer les changements de schéma DB (dev uniquement)
- Env requis : `DATABASE_URL` — chaîne de connexion Postgres
- Secret requis : `TELEGRAM_BOT_TOKEN` — obtenu via @BotFather
- Env optionnel : `ADMIN_TELEGRAM_IDS` — IDs Telegram admin séparés par virgule
- Env optionnel : `REQUIRED_CHANNEL` — canal obligatoire, ex : `@moncanal`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API : Express 5
- DB : PostgreSQL + Drizzle ORM
- Telegram : Telegraf 4
- Validation : Zod (`zod/v4`), `drizzle-zod`
- API codegen : Orval (depuis spec OpenAPI)
- Build : esbuild

## Where things live

- `lib/api-spec/openapi.yaml` — contrat API (source de vérité)
- `lib/db/src/schema/` — tables DB : users, referrals, tasks, userTasks, withdrawals
- `artifacts/api-server/src/lib/bot.ts` — bot Telegram (Telegraf, entièrement en français)
- `artifacts/api-server/src/routes/` — routes API : users, tasks, leaderboard, admin, withdrawals
- `lib/api-zod/src/generated/` — validateurs Zod générés (côté serveur)

## Architecture decisions

- Bot en long-polling dans le même process Express — pas de service séparé
- Récompense parrainage : 800 F par invitation valide
- Bonus quotidien : 200 F / 24h (nécessite au moins 1 tâche complétée)
- Retrait minimum : 10 000 F, avec approbation admin obligatoire
- `onConflictDoNothing()` sur l'insertion utilisateur — `/start` idempotent
- Accès admin via `ADMIN_TELEGRAM_IDS` (variable d'environnement)
- Anti-fraude : détection parrainage rapide (>5 en 5 min = flag), comptes créés simultanément bloqués
- Retraits refusés = solde recrédité automatiquement

## Product (Fonctionnalités)

Les utilisateurs interagissent via le menu du bot :
- **Mon Solde** — voir son solde, parrainages, tâches complétées
- **Mon Lien de Parrainage** — lien unique (800 F par ami inscrit)
- **Mes Tâches** — compléter des missions pour gagner des fonds (`/valider_<id>`)
- **Classement** — top 10 parrains
- **Bonus Quotidien** — 200 F/jour après avoir complété au moins 1 tâche
- **Retrait** — demander un retrait (min 10 000 F, approbation admin)
- **Aide** — guide complet

Commandes admin (via `ADMIN_TELEGRAM_IDS`) :
- `/admin` — liste des commandes admin
- `/admin_stats` — statistiques communautaires
- `/admin_solde <id> <montant>` — ajuster le solde
- `/admin_bonus <id> <montant>` — attribuer un bonus (notifie l'utilisateur)
- `/admin_ban` / `/admin_unban` — modération
- `/admin_fraude` — liste des comptes signalés
- `/admin_tache <récompense> <titre> | <desc>` — créer une tâche
- `/admin_taches` — lister toutes les tâches
- `/admin_retraits` — retraits en attente
- `/admin_approuver_<id>` — approuver un retrait
- `/admin_rejeter_<id> <raison>` — rejeter un retrait (solde recrédité)

## Système Anti-Fraude

- Détection parrainage rapide : >5 parrainages en 5 minutes → flag
- Comptes créés simultanément (<30s d'écart) → parrainage non crédité
- Comptes frauduleux marqués `flaggedForFraud = true`
- Seuls les comptes non-frauduleux apparaissent au classement
- `/admin_fraude` pour voir et gérer les comptes suspects

## Canal Obligatoire

Définir `REQUIRED_CHANNEL=@nomducanal` pour forcer l'adhésion au canal avant toute utilisation du bot. Le bot vérifie automatiquement l'adhésion à chaque commande.

## Retraits

Flux complet :
1. Utilisateur demande un retrait (min 10 000 F)
2. Choisit la méthode : Mobile Money, Virement Bancaire, PayPal, Crypto
3. Fournit ses coordonnées
4. Solde débité immédiatement, statut "en attente"
5. Admin reçoit une notification avec `/admin_approuver_<id>` ou `/admin_rejeter_<id>`
6. Si rejeté : solde recrédité automatiquement + notification utilisateur

## User preferences

- Futur : intégration crypto/TON pour les retraits
- Panneau admin via commandes bot (pas de web UI nécessaire pour l'instant)
- Fonctionnalités communautaires scalables

## Gotchas

- Toujours relancer `pnpm --filter @workspace/api-spec run codegen` après modification de `openapi.yaml`
- Toujours relancer `pnpm --filter @workspace/db run push` après modification des schémas DB
- Le bot utilise le long-polling — une seule instance doit tourner à la fois
- Pour accès admin : `ADMIN_TELEGRAM_IDS=123456789,987654321`
- Pour canal obligatoire : `REQUIRED_CHANNEL=@nomducanal`
