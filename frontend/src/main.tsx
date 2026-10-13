import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { Monitor } from '@/routes/Monitor'

// The interface is one page: the monitor's dock, with the stage the shell puts
// the game on above it.
createRoot(document.getElementById('root')!).render(<StrictMode><Monitor /></StrictMode>)
