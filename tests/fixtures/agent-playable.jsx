import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentPlayableMedia, useAgentPlayableMedia } from '../../src/components/AgentPlayableMedia'
import { AgentMessageContent } from '../../src/components/AgentMessageContent'
import '../../src/index.css'
import '../../src/components/ConnectedAgentPanel.css'
function Fixture() {
  const [chatId,setChat] = useState('chat'),[later,setLater] = useState(false),[disabled,setDisabled] = useState(false),[empty,setEmpty] = useState(false)
  const media=useAgentPlayableMedia({projectPath:window.fixtureProject,chatId,turnIds:['one','two'],assets:null})
  return <main className="connected-agent-panel" style={{width:600,maxWidth:'100%',margin:'auto',background:'#17212d',color:'white',padding:20}}>
    <button onClick={()=>setChat(id=>id==='chat'?'other':'chat')}>Switch chat</button>
    <button onClick={()=>setLater(true)}>Later reply</button>
    <button onClick={()=>setDisabled(value=>!value)}>Toggle busy</button>
    <button onClick={()=>setEmpty(value=>!value)}>Toggle empty library</button>
    <article id="first"><AgentPlayableMedia key={chatId} items={media.items.filter(i=>i.turnId==='one')} candidates={empty?[]:media.candidates} onAttach={ids=>media.attach('one',ids)} disabled={disabled}>
      {actions=><AgentMessageContent text="Original reply" copyable actions={actions}/>}</AgentPlayableMedia></article>
    {later && <article id="later"><AgentPlayableMedia items={media.items.filter(i=>i.turnId==='two')} candidates={media.candidates} onAttach={ids=>media.attach('two',ids)} disabled={disabled}>
      {actions=><AgentMessageContent text="Later reply content" copyable actions={actions}/>}</AgentPlayableMedia></article>}
    {media.error && <p role="alert">{media.error}</p>}
  </main>
}
createRoot(document.getElementById('root')).render(<Fixture />)
