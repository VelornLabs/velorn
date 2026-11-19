import './DirectorHero.css'
import heroCamera from '../../assets/director/hero-camera.webp'
import heroDancers from '../../assets/director/hero-dancers.webp'
import heroSinger from '../../assets/director/hero-singer.webp'
import heroBand from '../../assets/director/hero-band.webp'
import heroStreet from '../../assets/director/hero-street.webp'

// The Director's opening: the question and a fan of music video pictures.
// It stays at the top of every Director step, kept small. The pictures are decoration.
const PICTURES = [heroCamera, heroDancers, heroSinger, heroBand, heroStreet]

// `small` is set once the person scrolls down, so the step below gets more room.
export default function DirectorHero({ small = false }) {
  return (
    <div className={small ? 'dh dh-small' : 'dh'}>
      <h1 className="dh-title">What do you want to <span className="dh-glow">direct</span>?</h1>
      <div className="dh-fan" aria-hidden="true">
        {PICTURES.map((src) => <div key={src} className="dh-card"><img src={src} alt="" /></div>)}
      </div>
    </div>
  )
}
