import { createContext, useContext } from 'react';

/** True under a section's card; a page's own background is false. */
export const InCard = createContext(false);

/** Whether a control sits on a section's card, where text boxes are drawn filled rather than outlined. */
export function useInCard() {
  return useContext(InCard);
}

/** A text box on a card: a filled, softly rounded field, so it does not read as a second card. */
export const CARD_FIELD = { borderRadius: 12, height: 46, paddingHorizontal: 14 } as const;
export const CARD_AREA = { borderRadius: 12, paddingHorizontal: 14 } as const;
