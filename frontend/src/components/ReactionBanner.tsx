'use client'

import { useState } from 'react'
import { ArrowRight, ChevronDown, FlaskConical, Plus } from 'lucide-react'
import StructureView from './StructureView'

// The engine reaction result (from a /chat tool call or a photo /react-from-image),
// the same shape rendered by the inline ToolResultCards.
type ReactionProduct = { smiles: string; reaction_name?: string; steps_taken?: number }
type ReactionData = {
  substrate_smiles?: string
  reagent_smiles?: string
  environment?: string
  products?: ReactionProduct[]
}

// High-resolution source render. CSS owns the visible dimensions so each SVG
// fits its responsive panel instead of being clipped by a fixed pixel window.
const DRAW_W = 360
const DRAW_H = 240

// Full-reaction banner for the Reaction tab: draws substrate (+ reagent) → primary
// product as structures, with a button to reveal side reactions (the other
// products). Deliberately shows NO SMILES text — the drawing IS the answer.
export default function ReactionBanner({ reaction }: { reaction: Record<string, unknown> | null }) {
  const [showSide, setShowSide] = useState(false)

  const r = reaction as ReactionData | null
  if (!r || !r.substrate_smiles) return null

  const products = r.products ?? []
  const primary = products[0] ?? null
  const sideProducts = products.slice(1)

  return (
    <div className="reaction-banner">
      <div className={`reaction-banner-flow ${r.reagent_smiles ? 'with-reagent' : 'without-reagent'}`}>
        <div className="reaction-banner-mol">
          <StructureView smiles={r.substrate_smiles} width={DRAW_W} height={DRAW_H} fit />
        </div>
        {r.reagent_smiles && (
          <>
            <Plus size={17} className="reaction-banner-op reaction-banner-plus" />
            <div className="reaction-banner-mol">
              <StructureView smiles={r.reagent_smiles} width={DRAW_W} height={DRAW_H} fit />
            </div>
          </>
        )}
        <ArrowRight size={20} className="reaction-banner-op reaction-banner-arrow" />
        {primary ? (
          <div className="reaction-banner-mol primary">
            <StructureView smiles={primary.smiles} width={DRAW_W} height={DRAW_H} fit />
          </div>
        ) : (
          <div className="reaction-banner-nomatch">No verified product</div>
        )}
      </div>

      <div className="reaction-banner-foot">
        <span className="reaction-banner-head">
          <FlaskConical size={13} />
          {primary?.reaction_name ?? 'Reaction'}
        </span>
        {r.environment && <span className="reaction-banner-tag">{r.environment}</span>}
        {sideProducts.length > 0 && (
          <button
            type="button"
            className={`reaction-banner-side-toggle${showSide ? ' open' : ''}`}
            onClick={() => setShowSide(v => !v)}
            aria-expanded={showSide}
          >
            <ChevronDown size={13} />
            {showSide ? 'Hide' : 'Side'} reaction{sideProducts.length > 1 ? 's' : ''} ({sideProducts.length})
          </button>
        )}
      </div>

      {showSide && sideProducts.length > 0 && (
        <div className="reaction-banner-side">
          {sideProducts.map((product, index) => (
            <div key={index} className="reaction-banner-side-mol">
              <div className="reaction-banner-side-structure">
                <StructureView smiles={product.smiles} width={DRAW_W} height={DRAW_H} fit />
              </div>
              <span className="reaction-banner-side-name">{product.reaction_name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
