<div align="center">

# Velorn

**La station de travail vidéo IA open source — un vrai éditeur pour vous, et plus de 100 outils MCP pour votre agent.**

[![Latest Release](https://img.shields.io/github/v/release/VelornLabs/velorn?label=Latest&color=6C63FF)](https://github.com/VelornLabs/velorn/releases/latest)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue)](../../LICENSE)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-444444)](https://github.com/VelornLabs/velorn/releases/latest)

[![Website](https://img.shields.io/badge/Website-velorn.ai-0A9396)](https://velorn.ai)
[![Follow on X](https://img.shields.io/badge/Follow-%40getvelorn-000000?logo=x&logoColor=white)](https://x.com/getvelorn)
[![Join our Discord](https://img.shields.io/badge/Discord-Rejoindre%20la%20communaut%C3%A9-5865F2?logo=discord&logoColor=white)](https://discord.gg/QWZUuUChVK)

[![Download for Windows](https://img.shields.io/badge/Windows-T%C3%A9l%C3%A9charger-0078D4?style=for-the-badge)](https://github.com/VelornLabs/velorn/releases/latest)
[![Download for macOS](https://img.shields.io/badge/macOS-T%C3%A9l%C3%A9charger-1a1a1a?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/VelornLabs/velorn/releases/latest)
[![Download for Linux](https://img.shields.io/badge/Linux-T%C3%A9l%C3%A9charger-E95420?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/VelornLabs/velorn/releases/latest)

[English](../../README.md) · [Español](README.es.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Português (Brasil)](README.pt-BR.md) · Français

</div>

> Cette traduction est maintenue au mieux. En cas de doute, le [README anglais](../../README.md) fait foi. Les PR d'amélioration sont les bienvenues !

Velorn est une station de travail vidéo IA open source pour ordinateur, pensée pour les créateurs qui utilisent ComfyUI. Elle réunit la planification, la génération, la gestion des assets, le montage sur timeline, les sous-titres, les effets et l'export dans une seule application organisée par projets.

Utilisez les workflows locaux et cloud intégrés, apportez votre propre JSON de workflow de l'API ComfyUI, ou installez le Velorn Bridge inclus pour qu'un graphe ouvert dans ComfyUI puisse être renvoyé vers Velorn.

<p align="center">
  <img src="../readme/editor-timeline.png" alt="Éditeur Velorn avec assets générés, prévisualisation, pistes de timeline et inspecteur" />
</p>

## À quoi sert Velorn

- Créer des clips musicaux à partir de paroles, de synchronisation, de personnages, de keyframes, de plans vidéo et de montages sur timeline.
- Construire des publicités de type UGC pour créateurs et des publicités pour petites entreprises, avec des plans de tournage éditables.
- Exécuter des workflows image/vidéo sélectionnés, locaux et cloud, depuis un espace Generate unique.
- Exécuter des workflows ComfyUI personnalisés d'image, de vidéo, de keyframes et de clip musical dans l'application.
- Monter les clips générés avec pistes, transitions, effets, sous-titres, outils de proxy/cache et export.
- Garder les médias générés, les prompts, les sorties de workflows et les timelines organisés dans un projet.

Velorn ne remplace pas ComfyUI. C'est la couche de production autour de ComfyUI : planifier le travail, envoyer les tâches à ComfyUI, récupérer les sorties et finir le montage.

<p align="center">
  <img src="../readme/create-workflows.png" alt="Espace Create de Velorn avec créateurs UGC, publicité, clip musical et court-métrage" />
</p>

## Téléchargement

La plupart des utilisateurs devraient télécharger l'application de bureau packagée depuis la [page Releases de GitHub](https://github.com/VelornLabs/velorn/releases).

Les fichiers de chaque release incluent :

- `Windows Installer`
- `Windows Portable`
- `Mac (Apple Silicon)`
- `Mac (Intel)`
- `Linux AppImage`
- `Linux deb`

Ignorez les archives de code source générées automatiquement par GitHub, sauf si vous comptez compiler Velorn depuis les sources.

## Fonctionnalités principales

### Generate

Generate exécute des workflows locaux intégrés, des workflows cloud/partenaires et des workflows ComfyUI personnalisés.

- Workflows locaux d'image, de vidéo, d'édition d'image, d'audio et utilitaires.
- Workflows cloud comme Nano Banana 2, GPT Image 2, Seedance, Kling et d'autres routes de nœuds partenaires lorsque disponibles.
- Workflows Custom Image et Custom Video pour ceux qui veulent que Velorn exécute leurs propres graphes de l'API ComfyUI.
- Import de JSON d'API pour les utilisateurs avancés qui préfèrent exporter leurs workflows manuellement depuis ComfyUI.
- Prise en charge du Velorn Bridge : les graphes compatibles peuvent être envoyés de ComfyUI vers le bon panneau de Velorn.
- Vérifications de configuration du workflow : nœuds, modèles, identifiants et réglages manquants.
- Un navigateur Featured / My Workflows / Templates avec filtres Local et Cloud. Les workflows communautaires importés apparaissent dans Featured à côté des workflows intégrés.

<p align="center">
  <img src="../readme/generate-featured.png" alt="Navigateur Generate de Velorn avec workflows en vedette, filtres Local et Cloud et vérificateur de dépendances" />
</p>

L'onglet Templates parcourt le catalogue officiel de modèles ComfyUI (plus de 500 modèles avec taille et popularité) et ouvre n'importe lequel dans l'onglet ComfyUI intégré.

<p align="center">
  <img src="../readme/generate-templates.png" alt="Navigateur de modèles Velorn affichant le catalogue officiel de modèles ComfyUI avec catégories et filtres" />
</p>

### Create

Create contient des workflows créateurs guidés, construits sur le moteur Director Mode de Velorn.

- **Music Video Creation** - transforme une chanson, la synchronisation des paroles, des personnages, des références et un script de réalisation en keyframes, plans vidéo et une timeline éditable.
- **UGC Creator** - construit des publicités sociales façon créateur avec accroches, dialogues, démos produit, essayages, témoignages et sorties éditables plan par plan.
- **Business Ad Creator** - construit des publicités centrées sur l'offre pour commerces locaux, produits e-commerce, événements, services et petites équipes.
- **Short Film Creation** - workflow expérimental du scénario à la couverture de scènes. Encore très bêta, avec de possibles aspérités.

### Music Video Creation

Le créateur de clips musicaux prend en charge :

- L'import de chansons et la synchronisation des paroles.
- La transcription ASR ou l'alignement de paroles collées en SRT.
- La configuration des personnes/du casting, y compris les fiches de personnages existantes.
- Les prompts de keyframe par plan, images de référence, copie et édition de prompts, remplacement d'images et relance de plans.
- Des routes de keyframes intégrées comme Qwen Image Edit et Nano Banana 2.
- Des workflows de keyframes personnalisés utilisant les nœuds d'endpoint Velorn.
- Des routes vidéo intégrées comme LTX 2.3 Music et WAN 2.2.
- Des workflows vidéo personnalisés avec injection optionnelle d'image de keyframe, prompt, seed, largeur, hauteur, FPS, durée et audio.
- L'assemblage de la timeline à partir des assets de plans générés.

### Éditeur de timeline

L'éditeur comprend :

- Un navigateur d'assets du projet.
- Une timeline multipiste vidéo/audio.
- Le rognage et déplacement de clips, le magnétisme, le comportement de remplacement par chevauchement et les transitions.
- Des outils de texte, formes, titres, couleur unie, calques de réglage, keyframes et effets visuels.
- Les contrôles de l'Inspector.
- Des outils de proxy/cache pour une lecture plus fluide.
- Un panneau d'export pour les rendus finaux.

### Sous-titres

Les sous-titres peuvent être générés à partir de l'audio monté de la timeline et stylisés dans l'application.

- Transcription consciente de la timeline.
- Préréglages de style de sous-titres.
- Contrôles de police, couleur, contour, fond, ombre et animation.
- Préréglages de style enregistrés pour réutilisation.
- Prévisualisation en direct avec lecture/scrub et repères de zones sûres.
- Rendus de sous-titres prêts à l'export.

### Export

L'onglet Export comprend des préréglages de rendu pratiques, des options accélérées matériellement quand disponibles, des contrôles de file d'attente et des réglages de sortie adaptés au projet.

<p align="center">
  <img src="../readme/export-settings.png" alt="Réglages d'export Velorn avec préréglages, contrôles de codec et file d'export" />
</p>

### Stock

L'onglet Stock utilise Pexels pour rechercher et importer des photos ou vidéos directement dans le projet en cours. La clé API Pexels est optionnelle et peut être ajoutée dans Settings.

<p align="center">
  <img src="../readme/stock-pexels.png" alt="Onglet Stock de Velorn avec recherche de photos et vidéos Pexels" />
</p>

### Intégration ComfyUI

Velorn communique avec un serveur ComfyUI local et peut aussi aider à le lancer.

- Endpoint par défaut : `http://127.0.0.1:8188`
- Port personnalisé pris en charge dans Settings.
- Lanceur Windows pour un script de démarrage ComfyUI configuré.
- Lanceur macOS pour une `ComfyUI.app` configurée.
- Comportements optionnels de démarrage auto, arrêt à la fermeture et redémarrage.
- Onglet ComfyUI intégré pour ouvrir et éditer des graphes.
- Connexion au compte ComfyUI dans l'onglet intégré.
- Affichage du solde de crédits ComfyUI quand disponible.

L'application de bureau ne prend en charge que les endpoints ComfyUI en localhost/loopback.

### Agents IA (MCP)

Velorn inclut un serveur MCP local avec plus de 100 outils pour Codex, Claude Code, les outils compatibles Cursor et les autres clients MCP.

- Endpoint : `http://127.0.0.1:19790/mcp`
- Configuration dans l'app : `Settings > Agents (MCP)` (une commande à copier-coller par client)
- Guide : [docs/MCP.md](../MCP.md)

Les agents peuvent inspecter le projet ouvert, examiner les images de la timeline et les plans visibles, diagnostiquer la configuration ComfyUI, prévisualiser des modifications sûres de la timeline, mettre en file des générations approuvées et lancer des exports de livraison.

Les agents peuvent aussi importer des workflows ComfyUI communautaires : donnez-leur un lien ou un fichier de workflow, et ils analysent le graphe, signalent les nœuds personnalisés et modèles manquants, les installent après votre approbation et exécutent le workflow avec les assets de votre timeline.

Les outils d'écriture prévisualisent d'abord leur plan et ne l'appliquent qu'après approbation, sur la pile d'annulation normale de Velorn. MCP est la voie d'automatisation recommandée pour la revue assistée par agent, les opérations de timeline, le peaufinage graphique et les workflows de génération.

<p align="center">
  <img src="../readme/agents-mcp.png" alt="Réglages Agents (MCP) de Velorn avec le serveur local en cours d'exécution, les commandes de connexion et la liste complète des outils" />
</p>

## Workflows personnalisés

Les workflows personnalisés sont l'une des principales raisons d'être de Velorn.

Les utilisateurs avancés peuvent :

1. Ouvrir un graphe de départ depuis Velorn.
2. Le modifier dans ComfyUI.
3. Conserver les nœuds d'endpoint Velorn requis.
4. Le renvoyer avec le Velorn Bridge ou importer manuellement le JSON du workflow d'API.
5. Exécuter ce graphe depuis Velorn dans un flux créateur ou depuis Generate.

Les titres courants des nœuds d'endpoint Velorn :

- Velorn input image - `VELORN_INPUT_IMAGE`
- Velorn prompt - `VELORN_PROMPT`
- Velorn seed - `VELORN_SEED`
- Velorn width - `VELORN_WIDTH`
- Velorn height - `VELORN_HEIGHT`
- Velorn FPS - `VELORN_FPS`
- Velorn duration - `VELORN_DURATION`
- Velorn audio - `VELORN_AUDIO`
- Velorn output image - `VELORN_OUTPUT_IMAGE`
- Velorn output video - `VELORN_OUTPUT_VIDEO`

Les titres exacts `VELORN_*` sont préférés, mais Velorn reconnaît aussi des titres lisibles comme `Velorn input image`. Les anciens graphes utilisant encore les titres `COMFYSTUDIO_*` restent pris en charge pour la rétrocompatibilité.

Si un endpoint est présent, Velorn peut injecter cette valeur. S'il est absent, le graphe contrôle lui-même ce réglage.

<p align="center">
  <img src="../readme/comfyui-bridge.png" alt="Graphe ComfyUI intégré avec nœuds d'endpoint Velorn et bouton Send to Velorn" />
</p>
