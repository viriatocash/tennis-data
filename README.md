# tennis-data

Jeu de données tennis (classements ATP/WTA et tournois) au format JSON, pour
l'**analyse et la recherche value betting**. Généré automatiquement à partir des
données ouvertes de Jeff Sackmann.

## Source & licence
Données dérivées des dépôts publics de Jeff Sackmann
([tennis_atp](https://github.com/JeffSackmann/tennis_atp) et
[tennis_wta](https://github.com/JeffSackmann/tennis_wta)), sous licence
**Creative Commons Attribution-NonCommercial-ShareAlike 4.0**.

## Contenu
- `players/{atp|wta}/{slug}.json` — historique de classement par joueur.
- `rankings/{atp|wta}/{saison}.json` — classements de la saison.
- `tournaments/{atp|wta}/{saison}.json` — tournois de la saison.

Régénéré automatiquement chaque semaine.
