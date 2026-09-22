import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

class ErrorBoundary extends React.Component<{children:React.ReactNode},{error:string}> {
  state={error:''};
  static getDerivedStateFromError(error:Error){return {error:error.message};}
  render(){return this.state.error?<div className="boot-screen"><h1>Folio 遇到了一个问题</h1><p>{this.state.error}</p><button onClick={()=>location.reload()}>重新打开阅读器</button></div>:this.props.children;}
}
ReactDOM.createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
