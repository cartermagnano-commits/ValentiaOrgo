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

const MOL_W = 128
const MOL_H = 92

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
      <div className="reaction-banner-flow">
        <div className="reaction-banner-mol">
          <StructureView smiles={r.substrate_smiles} width={MOL_W} height={MOL_H} />
        </div>
        {r.reagent_smiles && (
          <>
            <Plus size={15} className="reaction-banner-op" />
            <div className="reaction-banner-mol">
              <StructureView smiles={r.reagent_smiles} width={MOL_W} height={MOL_H} />
            </div>
          </>
        )}
        <ArrowRight size={18} className="reaction-banner-op" />
        {primary ? (
          <div className="reaction-banner-mol primary">
            <StructureView smiles={primary.smiles} width={MOL_W} height={MOL_H} />
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
              <StructureView smiles={product.smiles} width={104} height={76} />
              <span className="reaction-banner-side-name">{product.reaction_name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
